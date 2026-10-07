/**
 * dsh-session-eater — 宿主半边。
 *
 * 职责：
 *   1. 提供 `/dsh-session-eater/*` HTTP 路由：删除（喂鱼）、撤销（捞回来）、用量、
 *      回收站可用性查询、形象兜底图、自检状态；
 *   2. 真正执行「吃掉一个会话」：先把它从工作区账目与归档集合里摘掉，再把会话目录
 *      **送进 Windows 系统的回收站**（`SHFileOperationW` + `FOF_ALLOWUNDO`，不是删除），
 *      清掉投影缓存，最后向所有已连接的浏览器广播 `api-session/removed`。
 *
 * ♻️ **删除 = 进回收站，可撤销。** 撤销靠解析回收站的 `$I` 元数据文件拿回原始路径，
 * 把对应的 `$R` 内容搬回原位。**一旦用户在资源管理器里清空回收站**，`$I`/`$R` 都没了，
 * 插件这边也就查不到、撤不回来了 —— 这正是设计意图：撤销能力跟着系统回收站走。
 *
 * 为什么自己实现删除：DSH 内核 0.1.5-rc.2 并没有可用的会话删除 RPC ——
 * `workspace/deleteSession` / `workspace/unarchiveSession` 只在 typert 清单里
 * 声明（见 @deepseek-ai/dsh-api-workspace-controller/lib/typert.host.js），
 * 宿主侧的 WorkspaceController 里并没有对应实现，调用只会失败。所以这里用
 * 内核已有的公开服务自己完成：ctx.workspaceRegistry（账目/归档）+
 * 文件系统 + Windows Shell + ctx.emit("api-session/removed")（前端实时同步）。
 *
 * @module dsh-session-eater
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 插件名（cordis loader 行 id 与客户端模块 id 都用它）。 */
export const name = 'dsh-session-eater'
/** 依赖宿主 webServer 服务来注册路由。 */
export const inject = ['webServer']
/**
 * 宿主半边版本；/status 会报出来，方便确认热重载到底有没有生效。
 *
 * 从 package.json 读，**不要写死** —— 之前写死成 '0.3.0'，结果包已经到 0.4.x 了
 * /status 还在报 0.3.0，排障时差点把"宿主是新的"误判成"宿主没重载"。
 */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return 'unknown'
  }
})()

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSET_FALLBACK_IMAGE = join(HERE, '..', 'assets', 'whale-fallback.png')
/**
 * 可以「端上来」的那几只碗（透明底 PNG）。
 *
 * 三只碗**都已经内联进客户端**（`lib/client.js` 的 `RICE_EXTRA_DATA`，由
 * `build-rice-models.mjs` 从这里的 PNG 生成），所以换碗不必重启宿主；
 * 这里注册路由是兜底 —— 客户端那份内联数据缺失时它才会来取。
 * 路由写成一张表，加碗只要往这里加一行，不用再抄一遍 handler。
 */
const RICE_BOWLS = {
  'rice-bowl.png': join(HERE, '..', 'assets', 'rice-bowl.png'),
  'rice-bowl-fried.png': join(HERE, '..', 'assets', 'rice-bowl-fried.png'),
  'rice-bowl-coin.png': join(HERE, '..', 'assets', 'rice-bowl-coin.png')
}
/** 本插件所有路由的公共前缀。 */
const BASE = '/dsh-session-eater'
/** 会话 id 只允许这一种形状，杜绝路径穿越。 */
const SESSION_ID_RE = /^session-[A-Za-z0-9][A-Za-z0-9._-]*$/
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
}

/**
 * 回收站桥的 PowerShell 脚本。
 *
 * 为什么是 PowerShell：把**整个目录**送进 Windows 回收站、并且还能拿回原始路径，
 * 只有 Shell API 这条路。本机实测（见下面的取舍）：
 *   - `SHFileOperationW` + `FOF_ALLOWUNDO` 是唯一可靠地把目录送进回收站的办法；
 *   - `Shell.Application` COM 在本机**根本用不了**：它的 `Path` 属性在"隐藏已知扩展名"
 *     时退化成显示名，`InvokeVerb("restore")` 也找不到目标 —— 所以它一次都没被使用；
 *   - 回收站每个条目有两份元数据：`$I…` 记原始路径，`$R…` 是内容本体。
 *     解析 `$I…` 就能拿回删除前的绝对路径，再把 `$R…` 搬回去就是还原。
 *
 * ⚠️ 这个脚本必须以 **UTF-8 + BOM** 落盘：Windows PowerShell 5.1 在没有 BOM 时
 * 按 ANSI 读取 .ps1，中文注释会被拆坏、报 `MissingEndCurlyBrace`（踩过一次）。
 * 《也因此这里用模板字符串保存，写盘时补 BOM。》
 */
const RECYCLE_PS1 = `# dsh-session-eater recycle bridge
#
# Contract:
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File recycle.ps1 -In <payload.json> -Out <result.json>
#   payload: { "action": "delete" | "restore" | "detect", "paths": [...] }
#   result : { ok, error, deleted, failed, index, matches }
#
# delete  : 把 paths 送进 Windows 回收站（SHFileOperationW + FOF_ALLOWUNDO），删前记下原始路径由系统写进说明文件
# restore : 按原始路径把回收站里的内容搬回去（找不到 = 用户已经清空过回收站，如实报错）
# detect  : 扫一遍回收站，回报 paths 里还有哪些仍然躺在里面（决定界面上的"撤销"还在不在）
param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'
$dollar = [char]36
$binRoot = 'C:\\' + $dollar + 'Recycle.Bin'

function Read-JsonFile([string]$path) {
  $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  if ([string]::IsNullOrWhiteSpace($text)) { return @{} }
  return ($text | ConvertFrom-Json)
}

# 解析回收站说明文件：原始路径是 UTF-16LE，长度前缀在偏移 24、正文在 28。
function Read-Index {
  $items = @()
  $sidDirs = Get-ChildItem -LiteralPath $binRoot -Force -Directory -ErrorAction SilentlyContinue
  foreach ($sidDir in $sidDirs) {
    $metaFiles = Get-ChildItem -LiteralPath $sidDir.FullName -Force -Filter '$I*' -ErrorAction SilentlyContinue
    foreach ($f in $metaFiles) {
      try {
        $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
        if ($bytes.Length -lt 28) { continue }
        $size = [BitConverter]::ToInt64($bytes, 8)
        $deletedAt = [DateTime]::FromFileTime([BitConverter]::ToInt64($bytes, 16))
        $nameLen = [BitConverter]::ToInt32($bytes, 24)
        # 只认新版格式（Win10+）：$I 后面 6 位随机名 + 原扩展名，正文是 UTF-16LE 原始路径。
        # 老格式（Win8 及更早）这里读到 0，会自然被跳过 —— 那是十几年前删的东西，不该被我们还原。
        if ($nameLen -le 0) { continue }
        $take = $nameLen * 2
        if ((28 + $take) -gt $bytes.Length) { continue }
        $orig = [System.Text.Encoding]::Unicode.GetString($bytes, 28, $take).TrimEnd([char]0)
        $items += [pscustomobject]@{
          orig      = $orig
          name      = (Split-Path -Path $orig -Leaf)
          ifile     = $f.FullName
          rfile     = (Join-Path $sidDir.FullName ('$R' + $f.Name.Substring(2)))
          deletedAt = $deletedAt.ToString('o')
          size      = $size
        }
      } catch {
        # 单个坏条目不该毁掉整次扫描
      }
    }
  }
  return $items
}

function Send-ToRecycleBin([string[]]$paths) {
  if (-not ('DshEater.Shell' -as [type])) {
    Add-Type -Namespace DshEater -Name Shell -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct SHFILEOPSTRUCT {
  public IntPtr hwnd;
  public uint wFunc;
  public string pFrom;
  public string pTo;
  public ushort fFlags;
  public bool fAnyOperationsAborted;
  public IntPtr hNameMappings;
  public string lpszProgressTitle;
}
[DllImport("shell32.dll", CharSet=CharSet.Unicode)]
public static extern int SHFileOperation(ref SHFILEOPSTRUCT lpFileOp);
'@
  }
  $sb = New-Object System.Text.StringBuilder
  foreach ($p in $paths) { [void]$sb.Append($p); [void]$sb.Append([char]0) }
  [void]$sb.Append([char]0)
  $op = New-Object DshEater.Shell+SHFILEOPSTRUCT
  $op.wFunc = 3                                                          # FO_DELETE
  $op.pFrom = $sb.ToString()                                             # 双 null 结尾
  $op.fFlags = 0x40 -bor 0x10 -bor 0x4 -bor 0x400 -bor 0x200             # ALLOWUNDO|NOCONFIRMATION|SILENT|NOERRORUI|NOCONFIRMMKDIR
  $rc = [DshEater.Shell]::SHFileOperation([ref]$op)
  return @{ rc = $rc; aborted = $op.fAnyOperationsAborted }
}

$result = [ordered]@{
  ok = $false; error = ''; deleted = @(); failed = @(); index = @(); matches = @()
}

try {
  $payload = Read-JsonFile $In
  $action = [string]$payload.action
  if ([string]::IsNullOrWhiteSpace($action)) { $action = 'detect' }
  $paths = @()
  if ($null -ne $payload.paths) { $paths = @($payload.paths | Where-Object { $_ -ne $null -and "$_" -ne '' }) }

  switch ($action) {
    'delete' {
      $present = @()
      foreach ($p in $paths) { if (Test-Path -LiteralPath $p) { $present += $p } }
      $missing = @($paths | Where-Object { $present -notcontains $_ })
      if ($present.Count -eq 0) {
        $result.ok = $true
        $result.error = 'nothing on disk to remove'
      } else {
        $r = Send-ToRecycleBin $present
        if ($r.rc -ne 0) {
          throw ("SHFileOperation failed with code 0x{0:X} (aborted={1})" -f $r.rc, $r.aborted)
        }
        # SHFileOperation 会静默跳过锁住的条目，所以必须回头确认原路径真的没了。
        $stillThere = @()
        foreach ($p in $present) { if (Test-Path -LiteralPath $p) { $stillThere += $p } }
        if ($stillThere.Count -gt 0) {
          throw ("still on disk after SHFileOperation: " + ($stillThere -join '; '))
        }
        $result.ok = $true
        $result.deleted = $present
        $result.failed = @($missing | ForEach-Object { @{ path = $_; error = 'not on disk' } })
      }
    }
    'restore' {
      $index = Read-Index
      # 一个叶子名可能对应**多条**回收站条目（同一个会话 id 同时存在于两个工作区分桶时
      # 就是这样：删的时候两条都进去了）。所以这里收集**所有**匹配项，最后按回收站
      # 条目（$I 文件）去重 —— 不能只取第一条，也不能按叶子名去重，否则只会捞回一条。
      $plan = @{}
      foreach ($p in $paths) {
        $leaf = Split-Path -Path $p -Leaf
        foreach ($hit in ($index | Where-Object { $_.orig -eq $p -or $_.name -eq $leaf })) {
          $plan[$hit.ifile] = $hit
        }
      }
      $done = @()
      $bad = @()
      foreach ($hit in $plan.Values) {
        # 单个条目失败不影响其它条目
        try {
          $parent = Split-Path -Path $hit.orig -Parent
          if (-not [string]::IsNullOrWhiteSpace($parent)) {
            [void](New-Item -ItemType Directory -Path $parent -Force)
          }
          if (Test-Path -LiteralPath $hit.orig) {
            Remove-Item -LiteralPath $hit.orig -Recurse -Force
          }
          Move-Item -LiteralPath $hit.rfile -Destination $hit.orig -Force
          Remove-Item -LiteralPath $hit.ifile -Force
          $done += $hit.orig
        } catch {
          $bad += @{ path = $hit.orig; error = ("{0}" -f $_.Exception.Message) }
        }
      }
      $result.ok = ($bad.Count -eq 0)
      $result.deleted = $done
      $result.matches = $done
      $result.failed = @($bad)
      if ($done.Count -eq 0 -and $bad.Count -eq 0) { $result.ok = $false }
      if (-not $result.ok) {
        if ($bad.Count -gt 0) {
          $result.error = ("{0}" -f $bad[0].error)
        } else {
          $result.error = 'not in recycle bin (emptied?)'
        }
      }
    }
    'detect' {
      $index = Read-Index
      $result.ok = $true
      $result.index = $index
      $wanted = @{}
      foreach ($p in $paths) { $wanted[(Split-Path -Path $p -Leaf)] = $p }
      $hits = @()
      foreach ($item in $index) {
        if ($wanted.ContainsKey($item.name)) { $hits += $item.orig }
      }
      $result.matches = $hits
    }
    default {
      throw ("unknown action: " + $action)
    }
  }
} catch {
  $result.ok = $false
  $result.error = ("{0}" -f $_.Exception.Message)
}

$json = $result | ConvertTo-Json -Depth 6 -Compress
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
`

/** BOM：PowerShell 5.1 没有它就按 ANSI 读 .ps1，中文注释会炸。 */
const UTF8_BOM = '\uFEFF'

/**
 * 解析 DSH home（与内核 `dshHomePath()` 同优先级：$DSH_HOME 优先，否则 ~/.dsh）。
 * @returns {string} 绝对的 DSH home 路径。
 */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

/**
 * 读取请求体并解析 JSON，带大小上限。
 * @param {import('node:http').IncomingMessage} req - 请求对象。
 * @param {number} [limit] - 最大字节数。
 * @returns {Promise<Record<string, unknown>>} 解析后的 JSON 对象。
 */
function readJsonBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch (error) {
        reject(new Error(`invalid JSON body: ${String(error && error.message)}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 写出一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} payload - 要序列化的值。
 */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': String(body.length) })
  res.end(body)
}

/**
 * 判断一个路径是否是已存在的目录。
 * @param {string} path - 待检查路径。
 * @returns {Promise<boolean>} 是目录则 true。
 */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 定位磁盘上的会话目录：`$DSH_HOME/sessions/<工作区分桶>/<sessionId>`。
 * 未落盘的空白会话命中空数组，这是正常的（它不是错误）。
 * @param {string} home - DSH home。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<string[]>} 命中的会话目录。
 */
async function findSessionDirs(home, sessionId) {
  const root = join(home, 'sessions')
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const hits = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, sessionId)
    if (await isDirectory(candidate)) hits.push(candidate)
  }
  return hits
}

/**
 * 一个会话"进回收站"时要一起收走的路径：会话目录 + 它的投影缓存。
 *
 * 缓存也走回收站而不是硬删 —— 撤销时一并回来，语义一致（缓存丢了只是数字要重新算，
 * 但不该在"可撤销的删除"里夹一个不可撤销的动作）。
 * @param {string} home - DSH home。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<string[]>} 磁盘上真实存在的待收路径。
 */
async function recycleCandidatesFor(home, sessionId) {
  const dirs = await findSessionDirs(home, sessionId)
  const projCache = join(home, 'storages', 'session_projcache', 'sessions')
  const caches = []
  for (const name of [`${sessionId}.json`, `${sessionId}.json.tmp`]) {
    const candidate = join(projCache, name)
    if (existsSync(candidate)) caches.push(candidate)
  }
  return [...dirs, ...caches]
}

/** 桥脚本落盘位置（每次调用都覆盖写，避免读到上一次的残留）。 */
let bridgeScriptPath = null

/**
 * 把内嵌的 PowerShell 桥写到临时文件（UTF-8 **带 BOM**）。
 * @returns {Promise<string>} 脚本的绝对路径。
 */
async function ensureBridgeScript() {
  if (bridgeScriptPath !== null) return bridgeScriptPath
  const dir = join(tmpdir(), 'dsh-session-eater')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'recycle.ps1')
  await writeFile(file, UTF8_BOM + RECYCLE_PS1, 'utf8')
  bridgeScriptPath = file
  return file
}

/**
 * 调一次回收站桥。
 *
 * 为什么用"文件进文件出"而不是环境变量或命令行参数：会话路径里可能有引号、空格、
 * 反斜杠，命令行拼字符串迟早出事；写 JSON 文件最稳。为什么不用 stdout 收结果：
 * 同一份代码在受限沙箱里跑时，捕获子进程 stdio 会 `EPERM`，写文件则不受影响。
 *
 * @param {'delete'|'restore'|'detect'} action - 要做的事。
 * @param {string[]} paths - 目标路径（绝对路径）。
 * @returns {Promise<{ok: boolean, error?: string, deleted?: string[], failed?: object[], index?: object[], matches?: string[]}>} 桥的返回。
 */
async function runRecycleBridge(action, paths) {
  const script = await ensureBridgeScript()
  const dir = join(tmpdir(), 'dsh-session-eater')
  await mkdir(dir, { recursive: true })
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const inFile = join(dir, `in-${stamp}.json`)
  const outFile = join(dir, `out-${stamp}.json`)
  await writeFile(inFile, JSON.stringify({ action, paths }), 'utf8')
  try {
    await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-In', inFile, '-Out', outFile
    ], { timeout: 120000, windowsHide: true })
  } catch (error) {
    // 桥本身崩了（脚本语法错、PowerShell 不在）时，out 文件通常没写出来
    if (!existsSync(outFile)) {
      const detail = String((error && (error.stderr || error.message)) || error)
      return { ok: false, error: `recycle bridge failed: ${detail.slice(0, 400)}` }
    }
  }
  if (!existsSync(outFile)) return { ok: false, error: 'recycle bridge produced no output' }
  try {
    const parsed = JSON.parse(await readFile(outFile, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : { ok: false, error: 'bad bridge output' }
  } catch (error) {
    return { ok: false, error: `bad bridge output: ${String((error && error.message) || error)}` }
  } finally {
    await rm(inFile, { force: true }).catch(() => {})
    await rm(outFile, { force: true }).catch(() => {})
  }
}

/**
 * 批量问：这些路径里，哪些**还在** Windows 回收站里（= 还能撤销）。
 *
 * 注意返回值把"没查到"和"查不了"分开了：`checked=false` 表示桥没跑成功
 * （PowerShell 不在、脚本报错……），调用方**不能**据此认定"东西已经没了"。
 * @param {string[]} paths - 目标路径。
 * @returns {Promise<{checked: boolean, paths: Set<string>, error?: string}>} 结果。
 */
async function recycleRoomFor(paths) {
  if (paths.length === 0) return { checked: true, paths: new Set() }
  const result = await runRecycleBridge('detect', paths)
  if (result.ok !== true || !Array.isArray(result.matches)) {
    return {
      checked: false,
      paths: new Set(),
      error: String(result.error || 'recycle bridge unavailable')
    }
  }
  return { checked: true, paths: new Set(result.matches) }
}

/**
 * 读一个会话的累计 token 用量。
 *
 * 数据来自**内核自己的会话投影缓存**（`storages/session_projcache/sessions/<id>.json`）——
 * 里面 `rows.tokenUsage.val.totals` 就是 DSH 界面同源的权威数字。
 *
 * 特意**不去解** `session.v3.jsonl.zstd`：那是多帧 zstd，5MB 的会话要解出 19MB 文本、
 * 花 300ms；而且里面的 `data.usage` 是「每轮一条、上下文递增」的，求和会算出 5 亿这种
 * 荒谬值（正确读法是取最后一条的 totalTokens，还得自己拼 4 个 bucket）。投影缓存又小又准。
 *
 * @param {string} home - DSH home。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<object>} `{ total, uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, turns, steps }`；
 *   读不到时 `total` 是 null —— 这不是错误（空白会话本来就没有投影缓存）。
 */
export async function sessionTokenUsage(home, sessionId) {
  const file = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  try {
    const doc = JSON.parse(await readFile(file, 'utf8'))
    const rows = doc?.record?.rows ?? {}
    const totals = rows.tokenUsage?.val?.totals
    if (totals === null || totals === undefined) return { total: null, reason: 'no tokenUsage row' }
    const stats = rows.sessionStats?.val ?? {}
    const uncachedInputTokens = Number(totals.uncachedInputTokens) || 0
    const outputTokens = Number(totals.outputTokens) || 0
    const cacheReadTokens = Number(totals.cacheReadTokens) || 0
    const cacheWriteTokens = Number(totals.cacheWriteTokens) || 0
    return {
      total: uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      uncachedInputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      turns: Number(stats.turns) || 0,
      steps: Number(stats.steps) || 0
    }
  } catch (error) {
    return { total: null, reason: String((error && error.message) || error) }
  }
}

/**
 * 把会话重新挂回它的工作区（撤销时用）。
 *
 * 撤销只把目录搬回来是不够的：删除时 `detachSession` 已经把这个 id 从工作区账目里
 * 划掉了，不挂回去的话会话在"按工作区分组"的视图里就没有归属（只有单列表能看到）。
 *
 * 内核的 `workspace.attachSession(id)` 会读会话头部、拿 `cwd` 跟工作区路径比对，
 * **不匹配就抛错** —— 所以这里可以放心地"先试首选、再逐个试"，试错没有副作用；
 * 一旦挂上就立刻返回。
 *
 * 首选来源：删除时响应里带回去的 `workspaceId`（客户端记在台账里、撤销时回传）。
 * 它丢了也不要紧 —— 兜底会按会话目录所在的分桶去匹配工作区路径。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {string} sessionId - 会话 id。
 * @param {string} restoredDir - 刚搬回来的会话目录（用来兜底匹配分桶）。
 * @param {string} [preferredId] - 客户端记下的原工作区 id。
 * @returns {Promise<{attached: boolean, workspaceId?: string, tried?: string[], error?: string}>} 结果。
 */
async function attachToWorkspace(ctx, sessionId, restoredDir, preferredId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return { attached: false, error: 'no workspaceRegistry' }
  const workspaces = registry.list()
  /** 已经挂在这个工作区上就不用再动。 */
  for (const workspace of workspaces) {
    if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) {
      return { attached: true, workspaceId: workspace.id }
    }
  }

  /** 会话目录所在的分桶名 ←→ 工作区路径的转写（`C:\Users\x` → `--C-Users-x--`）。 */
  const bucketOf = (path) => {
    const body = String(path).replace(/^([A-Za-z]):/, '$1').replace(/[\\/:]/g, '-')
    return `--${body}--`
  }
  const restoredBucket = restoredDir === undefined ? '' : (restoredDir.split(/[\\/]/).slice(-2, -1)[0] ?? '')

  const ordered = []
  if (typeof preferredId === 'string' && preferredId !== '') {
    const hit = workspaces.find((w) => w.id === preferredId)
    if (hit !== undefined) ordered.push(hit)
  }
  // 分桶对得上的排前面，其余按原顺序兜底
  const rest = workspaces.filter((w) => !ordered.includes(w))
  rest.sort((a, b) => {
    const sa = bucketOf(a.path) === restoredBucket ? 0 : 1
    const sb = bucketOf(b.path) === restoredBucket ? 0 : 1
    return sa - sb
  })
  ordered.push(...rest)

  const tried = []
  for (const workspace of ordered) {
    if (typeof workspace.attachSession !== 'function') continue
    tried.push(workspace.id)
    try {
      await workspace.attachSession(sessionId)
      return { attached: true, workspaceId: workspace.id, tried }
    } catch {
      /* cwd 对不上 —— 试下一个 */
    }
  }
  return { attached: false, tried, error: 'no workspace accepted this session' }
}

/**
 * 把一个会话从工作区账目里摘出来（工作区本身保留）。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<string | undefined>} 摘除成功时返回所属工作区 id。
 */
async function detachFromWorkspace(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return undefined
  for (const workspace of registry.list()) {
    if (!Array.isArray(workspace.sessionIds) || !workspace.sessionIds.includes(sessionId)) continue
    await workspace.detachSession(sessionId)
    return workspace.id
  }
  return undefined
}

/**
 * 把会话移出归档集合（幂等；指向已消失会话的陈旧归档项也一并清掉）。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<boolean>} 归档集合确实发生了变化则 true。
 */
async function dropFromArchive(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return false
  const archived = registry.archivedSessionIds
  if (!Array.isArray(archived) || !archived.includes(sessionId)) return false
  await registry.unarchiveSession(sessionId)
  return true
}

/**
 * 会话是否正在跑（跑着的会话不允许喂鱼：宿主还握着它的写句柄）。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {string} sessionId - 会话 id。
 * @returns {boolean} 正在运行则 true。
 */
function isRunning(ctx, sessionId) {
  try {
    return ctx.get('agents')?.get?.(sessionId)?.status === 'running'
  } catch {
    return false
  }
}

/**
 * 「吃掉」一个会话：摘账目 → 把目录交给 Windows Shell 送进**系统回收站** → 清投影缓存 → 广播移除。
 *
 * **有后悔药**：目录不是 `rm` 掉的，是走 `SHFileOperationW` + `FOF_ALLOWUNDO` 送进回收站的，
 * 所以回收站里还在的时候能用 `/restore` 捞回来（靠回收站的 `$I` 说明文件拿回原路径）。
 * 回收站被清空之后，这份后悔药随之失效 —— 那时 `/restore` 会明确报「已不在回收站」。
 * 另：非 Windows 上这条桥跑不起来，会**直接报错**，不会偷偷退化成硬删。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<Record<string, unknown>>} 执行结果。
 */
async function eatSession(ctx, sessionId) {
  if (isRunning(ctx, sessionId)) {
    const error = new Error('该会话正在运行，先停止它再喂鱼')
    error.code = 'session-running'
    throw error
  }

  const home = dshHome()

  // 1. 先摘账目：即使磁盘操作失败，也不会留下指向已消失会话的工作区槽位。
  const workspaceId = await detachFromWorkspace(ctx, sessionId)
  const unarchived = await dropFromArchive(ctx, sessionId)

  // 2. 会话目录 + 投影缓存 → Windows 回收站。
  //    注意：**没送进去必须报错**。若这里静默成功，客户端会告诉用户"已吃掉"，
  //    而会话其实还在磁盘上、刷新就"复活" —— 那是最糟的失败模式。
  //    撤销能力完全托付给系统回收站：用户清空回收站之后，这里就查不到、撤不回来了。
  const candidates = await recycleCandidatesFor(home, sessionId)
  const sent = []
  const failures = []
  if (candidates.length > 0) {
    const bridge = await runRecycleBridge('delete', candidates)
    if (bridge.ok !== true) {
      const message = String(bridge.error || '回收站写入失败')
      for (const candidate of candidates) failures.push({ dir: candidate, error: message })
      ctx.logger.warn(`session-eater: 送回收站失败 ${sessionId}: ${message}`)
    } else {
      sent.push(...(Array.isArray(bridge.deleted) ? bridge.deleted : []))
      for (const item of (Array.isArray(bridge.failed) ? bridge.failed : [])) {
        // 'not on disk' 不算失败：本来就没这个东西（例如空白会话没有目录）
        if (item && item.error !== 'not on disk') failures.push({ dir: item.path, error: item.error })
      }
    }
  }
  if (failures.length > 0) {
    const error = new Error(`会话没能送进回收站（多半被内核占用）: ${failures.map((f) => f.error).join('; ')}`)
    error.code = 'move-failed'
    throw error
  }

  // 3. 广播给所有浏览器（api-session/removed 在 dsh-api-remotes 的转发白名单里，
  //    客户端会据此把这一行从会话列表里摘掉，无需刷新）。
  try {
    ctx.emit('api-session/removed', sessionId)
  } catch (error) {
    ctx.logger.warn(`session-eater: 广播 api-session/removed 失败: ${String(error && error.message)}`)
  }

  ctx.logger.info(
    `session-eater: 吃掉 ${sessionId}（已送进系统回收站，可撤销）` +
    `${workspaceId === undefined ? '' : `（工作区 ${workspaceId}）`}` +
    `${sent.length === 0 ? '（磁盘上无目录，仅摘账目）' : `（回收站 ${sent.length} 项）`}`
  )

  return {
    sessionId,
    moved: sent,
    recycled: sent.length,
    /** 撤销的落点就是系统回收站；`recallable` 由客户端通过 /recycle 复查。 */
    permanent: false,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    unarchived
  }
}

/**
 * 撤销一次喂鱼：按回收站里的说明文件把会话目录搬回原位。
 *
 * 找不到 = 用户已经把回收站清空了 —— 这时如实回报失败，不做任何"假装恢复"的事。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<Record<string, unknown>>} 恢复结果。
 */
async function restoreSession(ctx, sessionId, preferredWorkspaceId) {
  const home = dshHome()
  const sessionsRoot = join(home, 'sessions')
  // 会话目录在哪个分桶已经不知道了（账目已摘、目录已不在），所以按"任意分桶"生成
  // 候选路径；桥匹配用的是目录名，也就是 sessionId，跟哪个分桶无关（桥会按条目去重）。
  const candidates = []
  try {
    for (const entry of await readdir(sessionsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(sessionsRoot, entry.name, sessionId))
    }
  } catch {
    /* 没有 sessions 目录就算了，桥那边按目录名匹配 */
  }
  // 兜底分桶：桥找不到会话条目时会如实回报，所以这个候选不会造成泄漏
  candidates.push(join(sessionsRoot, '--restored--', sessionId))
  const projCache = join(home, 'storages', 'session_projcache', 'sessions')
  candidates.push(join(projCache, `${sessionId}.json`), join(projCache, `${sessionId}.json.tmp`))

  const result = await runRecycleBridge('restore', candidates)
  const restored = Array.isArray(result.deleted) ? result.deleted : []
  /** 只有真的把会话目录捞回来才算撤销成功 —— 只捞回缓存不算。 */
  const restoredDir = restored.find((path) => path.includes('sessions') && !path.includes('session_projcache'))
  if (restored.length === 0 || restoredDir === undefined) {
    const error = new Error(String(result.error || '回收站里找不到这个会话（可能已被清空）'))
    error.code = 'not-in-recycle-bin'
    throw error
  }
  const misses = Array.isArray(result.failed) ? result.failed : []
  if (misses.length > 0) {
    // 目录回来了但有些附带项没回来（例如缓存），不算失败，但要留痕
    ctx.logger.warn(`session-eater: 撤销 ${sessionId} 时部分项没回来: ${JSON.stringify(misses)}`)
  }

  // 目录回到磁盘之后，还要把它重新挂回工作区账目 —— 否则它在"按工作区分组"的视图里
  // 没有归属（只有单列表能看到）。挂不上不算撤销失败：东西已经回来了。
  const attach = await attachToWorkspace(ctx, sessionId, restoredDir, preferredWorkspaceId)
  if (attach.attached === true) {
    ctx.logger.info(
      `session-eater: 从回收站捞回 ${sessionId} → ${restoredDir}` +
      `（已挂回工作区 ${attach.workspaceId}；刷新页面后回到列表）`
    )
  } else {
    ctx.logger.warn(
      `session-eater: ${sessionId} 已从回收站捞回，但没挂回工作区（${String(attach.error)}）——` +
      ' 重启 dsh web 后它会重新出现在列表里'
    )
  }
  return { sessionId, restored, misses, workspaceId: attach.workspaceId, attached: attach.attached === true }
}

/**
 * 注册路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/delete`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const sessionId = String(body.sessionId || '')
        if (!SESSION_ID_RE.test(sessionId)) {
          sendJson(res, 400, { ok: false, error: `invalid sessionId: ${JSON.stringify(sessionId)}` })
          return
        }
        sendJson(res, 200, { ok: true, ...(await eatSession(ctx, sessionId)) })
      } catch (error) {
        const code = (error && error.code) || 'eat-failed'
        sendJson(res, code === 'session-running' ? 409 : 500, {
          ok: false,
          code,
          error: String((error && error.message) || error)
        })
      }
    }
  }), 'session-eater: /delete')

  // 撤销：把会话从 **Windows 回收站** 捞回原位。
  // 回收站被清空之后这里必然失败（code: not-in-recycle-bin），客户端据此把撤销入口收掉。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/restore`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const sessionId = String(body.sessionId || '')
        if (!SESSION_ID_RE.test(sessionId)) {
          sendJson(res, 400, { ok: false, error: `invalid sessionId: ${JSON.stringify(sessionId)}` })
          return
        }
        sendJson(res, 200, {
          ok: true,
          ...(await restoreSession(ctx, sessionId, String(body.workspaceId || '')))
        })
      } catch (error) {
        const code = (error && error.code) || 'restore-failed'
        sendJson(res, code === 'not-in-recycle-bin' ? 410 : 500, {
          ok: false,
          code,
          error: String((error && error.message) || error)
        })
      }
    }
  }), 'session-eater: /restore')

  // 复查：这些会话目录**还在不在 Windows 回收站里**（在 = 还能撤销）。
  // 客户端打开设置页 / 新开页面时问一次，用答案决定每条台账上还要不要显示撤销。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/recycle`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      try {
        const body = await readJsonBody(req, 64 * 1024)
        const ids = Array.isArray(body.sessionIds) ? body.sessionIds.map(String) : []
        const valid = ids.filter((id) => SESSION_ID_RE.test(id)).slice(0, 200)
        const home = dshHome()
        const candidates = []
        const owner = new Map()
        for (const id of valid) {
          const projCache = join(home, 'storages', 'session_projcache', 'sessions')
          for (const path of [
            join(home, 'sessions', '--restored--', id),
            join(projCache, `${id}.json`)
          ]) {
            candidates.push(path)
            owner.set(path, id)
          }
          try {
            for (const entry of await readdir(join(home, 'sessions'), { withFileTypes: true })) {
              if (!entry.isDirectory()) continue
              const path = join(home, 'sessions', entry.name, id)
              candidates.push(path)
              owner.set(path, id)
            }
          } catch { /* sessions 目录不在就算了 */ }
        }
        const room = await recycleRoomFor(candidates)
        const recoverable = valid.filter((id) => {
          for (const [path, ownerId] of owner) {
            if (ownerId === id && room.paths.has(path)) return true
          }
          return false
        })
        sendJson(res, 200, {
          ok: true,
          /** checked=false 表示这次没查成（桥不可用）—— 客户端不能拿它当"东西已经没了"用。 */
          checked: room.checked,
          recoverable,
          ...(room.checked ? {} : { error: room.error })
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
      }
    }
  }), 'session-eater: /recycle')

  // 客户端在**拖起会话时**就来问一次这个会话的 token 用量，好在确认弹窗里写出
  // 「你确定要吃掉这个消耗了 X token 的会话吗？」。读的是内核投影缓存，很快。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/usage`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const sessionId = String(body.sessionId || '')
        if (!SESSION_ID_RE.test(sessionId)) {
          sendJson(res, 400, { ok: false, error: `invalid sessionId: ${JSON.stringify(sessionId)}` })
          return
        }
        sendJson(res, 200, { ok: true, sessionId, ...(await sessionTokenUsage(dshHome(), sessionId)) })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
      }
    }
  }), 'session-eater: /usage')

  // 形象兜底：余额挂件不在场（或换了目录名）时，用包里自带的那张小鲸鱼。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/whale.png`,
    handler: async (req, res) => {
      try {
        const bytes = await readFile(ASSET_FALLBACK_IMAGE)
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          'content-length': String(bytes.length)
        })
        res.end(bytes)
      } catch (error) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`fallback image unavailable: ${String((error && error.message) || error)}`)
      }
    }
  }), 'session-eater: /whale.png')

  // 「大白饭」系列：拖拽幽灵图 + 药丸头像用的那几只碗（透明底 PNG，本插件自带）。
  // 三只碗都已内联进客户端（见文件上方 RICE_BOWLS 的注释），所以这几条路由是兜底；
  // 客户端那份内联数据缺失时才按需来取，取到后转成 dataURL 再交给 setDragImage
  // （拖拽快照对同源/内联图最稳）。
  for (const [file, abs] of Object.entries(RICE_BOWLS)) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/${file}`,
      handler: async (req, res) => {
        try {
          const bytes = await readFile(abs)
          res.writeHead(200, {
            'content-type': 'image/png',
            'cache-control': 'no-store',
            'content-length': String(bytes.length)
          })
          res.end(bytes)
        } catch (error) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(`rice bowl image unavailable (${file}): ${String((error && error.message) || error)}`)
        }
      }
    }), `session-eater: /${file}`)
  }

  /** 自检路由：确认插件活着、形象素材在不在、DSH home 解析成什么、删除走哪条路。 */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/status`,
    handler: (req, res) => {
      try {
        const home = dshHome()
        sendJson(res, 200, {
          ok: true,
          plugin: name,
          version: VERSION,
          home,
          sessionsRoot: join(home, 'sessions'),
          /** 删除语义：false = 进系统回收站、可撤销（清空回收站后就没法撤销了）。 */
          permanent: false,
          recycleBin: 'windows',
          // 桥脚本落盘位置；看一眼就知道有没有被写出来
          bridge: existsSync(join(tmpdir(), 'dsh-session-eater', 'recycle.ps1')),
          fallbackImage: existsSync(ASSET_FALLBACK_IMAGE),
          /** 每只碗在不在磁盘上（加碗之后自检一眼看出来，不用去翻 assets 目录）。 */
          bowls: Object.fromEntries(Object.entries(RICE_BOWLS).map(([file, abs]) => [file, existsSync(abs)]))
        })
      } catch (error) {
        sendJson(res, 200, { ok: false, where: 'status', error: String((error && error.stack) || error) })
      }
    }
  }), 'session-eater: /status')

  /** 最小连通性探针（排查路由冲突用）。 */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/ping`,
    handler: (req, res) => {
      sendJson(res, 200, { ok: true, pong: Date.now() })
    }
  }), 'session-eater: /ping')
}
