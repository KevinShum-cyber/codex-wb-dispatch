#!/usr/bin/env node
/*
 * workbuddy-bridge — 让 Claude Code / Claude Desktop 能直接调用本机的 WorkBuddy。
 *
 * 原理：MCP stdio server（零依赖）。收到工具调用后，spawn WorkBuddy 的命令行
 * 客户端，把任务书交给它、把它的完整输出原样返回给调用方。
 *
 * 为什么要走 MCP 而不是让 Claude 直接敲命令：
 *   1. 注册一次就永久可用，不必每次拼命令行；
 *   2. 模型名 / 权限旗标封在服务端，文档里那套过期的写法影响不到这里；
 *   3. 串行队列 —— 两个任务落到同一个目录会抢同一个本地端口而互相打死，
 *      这里统一排队，从根上避免。
 *
 * 本文件只往 stdout 写 JSON-RPC，任何调试信息一律走 stderr。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PROTOCOL_FALLBACK = '2024-11-05';
const SERVER_NAME = 'workbuddy-bridge';
const SERVER_VERSION = '1.0.1';

const DEFAULT_CLI = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy';
// 模型可用性（2026-09-29 更新）：deepseek-v4.1-flash 曾经会无声挂死（2026-09-15 两次实测，
// 均超过 150s 无任何输出、不报错），**该问题已修复，可正常使用**。
// 默认仍用 hy3（全天免费）；实测可用：glm-5.3-flash（快）、glm-5.3、deepseek-v4-pro、
// deepseek-v4.1-flash、hy3。
const DEFAULT_MODEL = process.env.WORKBUDDY_MODEL || 'hy3';
const DEFAULT_TIMEOUT_MS = Number(process.env.WORKBUDDY_TIMEOUT_MS || 1800000);
// 体检必须在调用方放弃之前返回，否则调用方只会看到「超时」，
// 永远拿不到底下的真实原因。60 秒足够，也让排障不用干等。
const HEALTH_TIMEOUT_MS = 60000;
const MAX_OUTPUT_BYTES = 400 * 1024;

function log(...args) {
  process.stderr.write(`[${SERVER_NAME}] ${args.join(' ')}\n`);
}

function resolveCli() {
  if (process.env.WORKBUDDY_CLI && existsSync(process.env.WORKBUDDY_CLI)) return process.env.WORKBUDDY_CLI;
  if (existsSync(DEFAULT_CLI)) return DEFAULT_CLI;
  return 'codebuddy';
}

const CLI = resolveCli();

/* ---------- 全局串行队列：同一条桥同时只跑一个任务 ---------- */
let queueTail = Promise.resolve();
function enqueue(job) {
  const run = queueTail.then(job, job);
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/* ---------- 子进程环境净化 ----------
 * WorkBuddy 会把整个母会话的状态塞进环境变量（broker IPC 地址、会话 ID、沙箱令牌……）。
 * 子进程如果原样继承，会去连母会话的 broker 然后挂死——这是实测出来的，
 * 嵌套启动时表现为「进程起来了、零输出、永远不返回」。
 * 桥可能被 Claude Desktop 启动（那时这些变量本来就不存在，剥离是无害的空操作），
 * 也可能被另一个 WorkBuddy 会话启动（那时剥离是保命）。所以一律剥离。
 */
const STRIP_PREFIXES = [
  'CODEBUDDY_',
  'CLAUDE_',
  'CLIENT_INFO_',
  'ACC_PRODUCT_CONFIG',
  'BAGGAGE',
  'BASH_ENV',
  'WORKBUDDY_',
  // 罪魁祸首：一个没有前缀的裸变量，值是母会话的本地服务端口。
  // 子进程读到它就原样去 bind，而那个端口正被母会话占着 → EADDRINUSE，
  // 而 WorkBuddy 命令行会把这条错误吞掉、无限挂起（零输出、永不返回）。
  'SERVER__',
  'editor_sdk_port',
];

function childEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (STRIP_PREFIXES.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  // PATH 同样要洗：母会话会把 vendor/shim/brokered-bin 这类垫片目录塞到最前面，
  // 子进程顺着 PATH 找到的就是「要连母会话 broker」的假命令，于是静默挂死。
  const raw = out.PATH || '';
  out.PATH = [...new Set(raw.split(':').filter((p) => p && !p.includes('/vendor/shim/')))].join(':');
  out.NO_COLOR = '1';
  out.FORCE_COLOR = '0';
  return out;
}

/* ---------- 调用 WorkBuddy ---------- */
function callWorkBuddy({ prompt, cwd, model, maxTurns, timeoutMs, extraArgs = [] }) {
  return new Promise((resolve) => {
    // 一定带 --debug：WorkBuddy CLI 在启动阶段出错（典型是端口被桌面端占住）时会
    // 把错误吞掉然后无限挂起，表现为「零输出、永不返回」。加上 --debug 才会把
    // EADDRINUSE 这类原因打到 stderr，桥才能把它翻译成人能看懂的话。
    const args = ['-p', prompt, '-y', '--debug', '--model', model || DEFAULT_MODEL];
    if (maxTurns) args.push('--max-turns', String(maxTurns));
    args.push(...extraArgs);

    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;

    let child;
    try {
      child = spawn(CLI, args, {
        cwd: cwd || process.cwd(),
        env: childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, code: null, stdout: '', stderr: `启动失败: ${err.message}`, ms: 0, truncated: false });
      return;
    }

    const limit = Number(timeoutMs || DEFAULT_TIMEOUT_MS);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {}
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr: `${stderr}\n[bridge] 超过 ${Math.round(limit / 1000)} 秒未结束，已终止。`,
        ms: Date.now() - started,
        truncated,
        timedOut: true,
      });
    }, limit);

    const append = (which, chunk) => {
      const text = chunk.toString('utf8');
      if (which === 'out') {
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += text;
        else truncated = true;
      } else {
        if (stderr.length < MAX_OUTPUT_BYTES) stderr += text;
        else truncated = true;
      }
    };

    child.stdout.on('data', (c) => append('out', c));
    child.stderr.on('data', (c) => append('err', c));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: `进程错误: ${err.message}`, ms: Date.now() - started, truncated });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const authFailure = /Authentication required|Authentication failed|Please use \/login/i.test(`${stdout}\n${stderr}`);
      resolve({ ok: code === 0 && !authFailure, code, stdout, stderr, ms: Date.now() - started, truncated, authFailure });
    });
  });
}

function diagnose(result, cwd) {
  const blob = `${result.stdout}\n${result.stderr}`;
  const hints = [];
  if (result.authFailure) {
    hints.push(
      'WorkBuddy 命令行未登录。请在终端运行一次 `wb-codebuddy` 完成扫码登录（独立安装的 CodeBuddy Code CLI），' +
        '之后无需重复登录。注意：桌面 App 内嵌的 CLI 无法独立登录，必须用独立安装版。',
    );
  }
  if (/EADDRINUSE/i.test(blob)) {
    hints.push(
      `端口冲突：在 ${cwd} 这个目录下已经有一个 WorkBuddy 会话在跑。` +
        '本命令本身带串行队列，说明冲突来自队列之外（比如桌面端正好打开着同一个目录）。' +
        '换一个工作目录，或先关掉那个会话再试。',
    );
  }
  // 只认「CLI 自己找不到」；避免把子命令（如 ioreg）的 command not found 误判成 CLI 缺失。
  const cliMissing =
    /ENOENT/i.test(blob) ||
    /(^|[\/\s])(codebuddy|codebuddy-code|wb-codebuddy|cbc):?\s+(command )?not found/i.test(blob);
  if (cliMissing) {
    hints.push(`找不到 WorkBuddy 命令行程序。当前使用：${CLI}（可用环境变量 WORKBUDDY_CLI 覆盖）。`);
  }
  if (/model|模型/i.test(blob) && /(unsupported|not found|invalid|不支持)/i.test(blob)) {
    hints.push(`模型名可能已失效，当前用的是 ${DEFAULT_MODEL}。改环境变量 WORKBUDDY_MODEL 换一个。`);
  }
  if (result.timedOut && !hints.length) {
    hints.push('任务超时未返回。长任务请调大 timeout_ms，或把任务拆小。');
  }
  if (!result.stdout.trim() && result.ok) {
    hints.push('进程正常退出但没有任何输出，任务很可能实际没执行。');
  }
  return hints;
}

function formatResult(result, cwd) {
  const parts = [];
  parts.push(`# 状态\n${result.ok ? '成功' : '失败'}（退出码 ${result.code ?? 'n/a'}，耗时 ${(result.ms / 1000).toFixed(1)}s）`);
  const hints = diagnose(result, cwd);
  if (hints.length) parts.push(`# 需要注意\n- ${hints.join('\n- ')}`);
  parts.push(`# WorkBuddy 的完整输出\n${result.stdout.trim() || '(空)'}`);
  if (result.stderr.trim()) parts.push(`# 附：stderr\n\`\`\`\n${result.stderr.trim()}\n\`\`\``);
  if (result.truncated) parts.push('（输出过长，已截断）');
  return parts.join('\n\n');
}

// 独立 CLI 会先在 stdout 打印本地服务启动信息（例如 `serve 59393`），
// 随后才打印模型回复。这个启动行不是模型输出，但也不能简单地把所有额外
// 内容都放宽，否则只有启动成功、模型根本没执行的情况会被误判为可派发。
// 因此只过滤格式明确的启动行，剩余内容仍须与固定短语完全一致。
function healthModelReply(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter((line) => !/^\s*serve\s+\d+\s*$/i.test(line))
    .join('\n')
    .trim();
}

/* ---------- 工具定义 ---------- */
const TOOLS = [
  {
    name: 'run_workbuddy',
    description:
      '把一个任务交给本机的 WorkBuddy agent 执行，等它跑完，返回它的完整输出。' +
      '适合：调研、资料归集、写文档、跨多个文件的批量改动、独立复核。' +
      '这是**一次性同步调用**——WorkBuddy 不会记得上一次的会话，每次都是新局面，' +
      '所以任务书必须自带全部背景（目标、边界、禁区、验收标准、相关文件路径），不要写"接着上次那个"。' +
      '调用会串行排队；长任务请调大 timeout_ms。' +
      '注意 WorkBuddy 自己也会写文件、跑命令，请把它当成一个真人协作者来派活，而不是一个纯函数。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '完整任务书。必须自足：背景 + 目标 + 边界 + 验收标准。WorkBuddy 看不到你的对话上下文。',
        },
        cwd: {
          type: 'string',
          description: 'WorkBuddy 在哪个目录下干活（绝对路径）。强烈建议显式传项目目录，否则它会在桥进程的当前目录里乱写。',
        },
        model: {
          type: 'string',
          description: `用哪个模型。默认 ${DEFAULT_MODEL}。调研类任务不建议换成推理更弱的小模型。`,
        },
        max_turns: { type: 'number', description: '最大回合数，防止在死路上空转。建议 40–80。' },
        timeout_ms: { type: 'number', description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}（30 分钟）。` },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'workbuddy_health',
    description:
      '体检：确认这座桥能不能真的把任务送到 WorkBuddy 手上。' +
      '会跑一条极短的任务并检查它有没有正常应答。桥不通、程序被挪走、模型名失效、目录被占用，都会在这里暴露出来。' +
      '排障时先跑这个。',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '在哪个目录下试。默认用桥进程的当前目录。' },
        model: { type: 'string', description: `用哪个模型试。默认 ${DEFAULT_MODEL}。` },
      },
    },
  },
];

/* ---------- JSON-RPC ---------- */
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};

  if (name === 'workbuddy_health') {
    const cwd = args.cwd || process.cwd();
    const result = await enqueue(() =>
      callWorkBuddy({
        prompt: '只回复两个字：打通',
        cwd,
        model: args.model,
        timeoutMs: HEALTH_TIMEOUT_MS,
      }),
    );
    const hints = diagnose(result, cwd);
    const effectiveReply = healthModelReply(result.stdout);
    const pass = result.ok && effectiveReply === '打通';
    const text = [
      `结论：${pass ? '桥通了' : '桥不通'}`,
      `程序：${CLI}`,
      `模型：${args.model || DEFAULT_MODEL}`,
      `目录：${cwd}`,
      `退出码：${result.code ?? 'n/a'}，耗时 ${(result.ms / 1000).toFixed(1)}s`,
      `原样返回的内容：${JSON.stringify(result.stdout.trim())}`,
      `有效模型回复：${JSON.stringify(effectiveReply)}`,
      hints.length ? `需要注意：\n- ${hints.join('\n- ')}` : '',
      result.stderr.trim() ? `stderr：\n\`\`\`\n${result.stderr.trim()}\n\`\`\`` : '',
    ]
      .filter(Boolean)
      .join('\n');
    reply(id, { content: [{ type: 'text', text }], isError: !pass });
    return;
  }

  if (name === 'run_workbuddy') {
    const prompt = args.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) {
      reply(id, { content: [{ type: 'text', text: 'prompt 不能为空。' }], isError: true });
      return;
    }
    const cwd = args.cwd || process.cwd();
    if (!existsSync(cwd)) {
      reply(id, { content: [{ type: 'text', text: `目录不存在：${cwd}` }], isError: true });
      return;
    }
    const result = await enqueue(() =>
      callWorkBuddy({
        prompt,
        cwd,
        model: args.model,
        maxTurns: args.max_turns,
        timeoutMs: args.timeout_ms,
      }),
    );
    reply(id, { content: [{ type: 'text', text: formatResult(result, cwd) }], isError: !result.ok });
    return;
  }

  replyError(id, -32602, `未知工具：${name}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log('收到非法 JSON，已忽略');
      continue;
    }
    dispatch(msg);
  }
});

process.stdin.on('end', () => process.exit(0));

async function dispatch(msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        reply(id, {
          protocolVersion: typeof requested === 'string' ? requested : PROTOCOL_FALLBACK,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
        return;
      }
      case 'notifications/initialized':
        return;
      case 'ping':
        if (!isNotification) reply(id, {});
        return;
      case 'tools/list':
        reply(id, { tools: TOOLS });
        return;
      case 'tools/call':
        await handleToolCall(id, params);
        return;
      default:
        if (!isNotification) replyError(id, -32601, `不支持的方法：${method}`);
    }
  } catch (err) {
    log('内部错误:', err?.stack || String(err));
    if (!isNotification) replyError(id, -32603, `桥内部错误：${err?.message ?? String(err)}`);
  }
}

log(`已启动。程序=${CLI} 模型=${DEFAULT_MODEL} 超时=${DEFAULT_TIMEOUT_MS}ms`);
