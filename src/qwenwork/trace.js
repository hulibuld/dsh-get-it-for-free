/**
 * shim 诊断日志：把请求级时序写到固定文件，独立于 DSH 的日志体系。
 *
 * 为什么需要它：排查「长思考超时」时发现——DSH 的 ctx.logger 不落盘，
 * harness.log 里看不到我们 shim 的任何输出，等于**在黑暗里调试**。
 * 这份文件日志给出每次请求的完整时间线：
 *   进入 → 鉴权结果 → 响应头到达 → 首帧 → 流结束/失败（含原因）
 *
 * ⚠️ 只写一行 JSON、追加模式，上限 2MB（超过即截断重开），
 *    避免长期运行撑爆磁盘。诊断完成后可整体移除本模块。
 *
 * 路径可用 QWEN_CONNECT_TRACE_PATH 覆盖（测试必须覆盖，否则单测的故障注入
 * 会混进真实排障日志里）。本包固定写 dsh-qwenwork-connect-trace.log，pi 侧
 * 插件固定写 pi-qwenwork-trace.log：两边共用一个文件时，DSH 的活跃
 * 流量会在几十分钟内把 pi 侧的事故记录轮转出上限（2026-10-29 踩到）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 当前诊断日志路径。每次调用时解析，测试可在运行中把写入重定向到
 * 项目内临时目录（QWEN_CONNECT_TRACE_PATH），避免污染真实排障日志。
 */
export function traceLogPath() {
  return (
    process.env.QWEN_CONNECT_TRACE_PATH ||
    path.join(os.tmpdir(), 'dsh-qwenwork-connect-trace.log')
  );
}

const MAX_BYTES = 2 * 1024 * 1024;

/** 追加一行诊断日志；失败静默（诊断工具绝不能反过来弄挂对话）。 */
export function trace(event, data = {}) {
  const logPath = traceLogPath();
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_BYTES) {
      fs.writeFileSync(logPath, '', 'utf8');
    }
    const line =
      JSON.stringify({ t: new Date().toISOString(), source: 'dsh-qwen-connect', pid: process.pid, event, ...data }) + '\n';
    fs.appendFileSync(logPath, line, 'utf8');
  } catch {
    /* 诊断日志绝不影响主流程 */
  }
}
