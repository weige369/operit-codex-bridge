/*
METADATA
{
    "name": "CodexBridge",
    "display_name": { "zh": "Codex CLI 桥接", "en": "Codex CLI Bridge" },
    "description": { "zh": "在 Android 设备上管理 Codex exec-server 的启动/停止/查询/调用。实际 shell 操作由 super_admin:shell 完成。", "en": "Manage Codex exec-server lifecycle and communication on Android." },
    "category": "Development",
    "dependencies": ["super_admin"],
    "tools": [
        { "name": "codex_status", "description": { "zh": "生成检查 Codex exec-server 状态的 shell 命令", "en": "Generate shell command to check Codex status" }, "parameters": [ { "name": "port", "description": "WebSocket 端口 (默认 9878)", "type": "integer", "required": false } ] },
        { "name": "codex_start", "description": { "zh": "生成启动 Codex exec-server 的 shell 命令（需用 super_admin:shell 执行）", "en": "Generate shell command to start Codex" }, "parameters": [ { "name": "port", "description": "WebSocket 端口 (默认 9878)", "type": "integer", "required": false } ] },
        { "name": "codex_stop", "description": { "zh": "生成停止 Codex exec-server 的 shell 命令", "en": "Generate shell command to stop Codex" }, "parameters": [ { "name": "port", "description": "端口 (默认 9878)", "type": "integer", "required": false } ] },
        { "name": "codex_call", "description": { "zh": "生成通过 WebSocket 调用 Codex 的 shell 命令或 JSON-RPC 请求", "en": "Generate shell command or JSON-RPC request to call Codex" }, "parameters": [ { "name": "prompt", "description": "prompt 文本", "type": "string", "required": true }, { "name": "port", "description": "端口 (默认 9878)", "type": "integer", "required": false }, { "name": "timeout_ms", "description": "超时毫秒 (默认 60000)", "type": "integer", "required": false } ] }
    ]
}
*/

var CodexBridge = (function() {
  'use strict';

  var DEFAULT_PORT = 9878;
  // 已知正确的路径（从 codex-android-dev APK 提取）
  var APK_LIB_DIR = '/data/app/~~EYU3KjctJPL3lXGtdBaYyg==/com.codex.android-tteLfCj-Eqoi5k-jjvkV4Q==/lib/arm64';
  var CODEX_DATA_DIR = '/data/data/com.codex.android/files';
  var ROOTFS = CODEX_DATA_DIR + '/linux-rootfs';
  var TMP_DIR = CODEX_DATA_DIR + '/tmp';
  var START_SCRIPT = CODEX_DATA_DIR + '/start_codex.sh';
  var LOG_FILE = '/sdcard/codex-bridge.log';

  function err(m) { return { success: false, message: '[CodexBridge] ' + m }; }
  function ok(d) { var r = { success: true }; for (var k in d) r[k] = d[k]; return r; }

  // codex_status
  async function codex_status(p) {
    var port = p.port || DEFAULT_PORT;
    return ok({
      port: port,
      method: '使用 super_admin:shell 执行以下命令检查状态',
      command: 'ss -ltnp 2>/dev/null | grep ' + port + ' && echo "RUNNING" || echo "STOPPED"; echo "---"; ps -Af 2>/dev/null | grep codex | grep -v grep | head -5'
    });
  }

  // codex_start
  async function codex_start(p) {
    var port = p.port || DEFAULT_PORT;

    var script = [
      '#!/system/bin/sh',
      'export LD_LIBRARY_PATH=' + APK_LIB_DIR,
      'export PROOT_LOADER=' + APK_LIB_DIR + '/libproot-loader.so',
      'export PROOT_TMP_DIR=' + TMP_DIR,
      'exec ' + APK_LIB_DIR + '/libproot.so',
      " --rootfs='" + ROOTFS + "'",
      ' --root-id --kill-on-exit',
      ' -b /dev -b /proc -b /sys -b /storage',
      ' -w /root',
      ' /usr/bin/env -i',
      ' HOME=/root',
      ' PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      ' TERM=xterm-256color LANG=C.UTF-8 SHELL=/bin/bash USER=root',
      ' /bin/bash -c',
      " '/usr/local/bin/codex exec-server --listen ws://0.0.0.0:" + port + "'"
    ].join('\n');

    // Write script via heredoc to temp file
    var writeCmd = 'cat > ' + START_SCRIPT + " << 'CEOF'\n" + script + '\nCEOF\nchmod +x ' + START_SCRIPT;

    var launchCmd = "sh -e -c 'umask 0022 && PATH=$PATH:/system/bin:/system/xbin:/vendor/bin:/vendor/xbin && run-as com.codex.android nohup sh " + START_SCRIPT + " > " + LOG_FILE + " 2>&1 & echo LAUNCHED'";

    return ok({
      port: port,
      steps: [
        { step: 1, description: '写入启动脚本', command: writeCmd },
        { step: 2, description: '通过 Shizuku shell domain 启动 Codex', command: launchCmd },
        { step: 3, description: '等待 5 秒后验证', command: 'sleep 5 && ss -ltnp 2>/dev/null | grep ' + port + ' && echo "SUCCESS" || cat ' + LOG_FILE }
      ],
      log_file: LOG_FILE
    });
  }

  // codex_stop
  async function codex_stop(p) {
    var port = p.port || DEFAULT_PORT;
    return ok({
      port: port,
      command: 'pkill -f "codex exec-server" 2>/dev/null; pkill -f "libproot.*' + port + '" 2>/dev/null; sleep 1; ss -ltnp 2>/dev/null | grep ' + port + ' || echo "STOPPED"'
    });
  }

  // codex_call
  async function codex_call(p) {
    var prompt = p.prompt;
    if (!prompt) return err('prompt 参数不能为空');
    var port = p.port || DEFAULT_PORT;
    var timeoutMs = p.timeout_ms || 60000;
    var timeoutSec = Math.floor(timeoutMs / 1000);
    var reqId = Date.now();

    return ok({
      port: port,
      method_websocat: {
        description: '使用 websocat（需在 proot Ubuntu 中安装）',
        command: "echo '{\"jsonrpc\":\"2.0\",\"id\":\"" + reqId + "\",\"method\":\"execute\",\"params\":{\"prompt\":\"" + prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n') + "\",\"stream\":true}}' | websocat -n1 --timeout " + timeoutSec + " ws://127.0.0.1:" + port
      },
      method_python: {
        description: '使用内置 Python WebSocket 客户端（在 Operit terminal 中执行）',
        command: "python3 -c \"\nimport socket, struct, json\ndef ws_rpc(port, msg, timeout):\n    s = socket.socket()\n    s.settimeout(timeout)\n    s.connect(('127.0.0.1', port))\n    # WebSocket handshake\n    import base64\n    key = base64.b64encode(b'\\x00'*16).decode()\n    req = f'GET / HTTP/1.1\\r\\nHost: 127.0.0.1:{port}\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: {key}\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n'\n    s.send(req.encode())\n    resp = b''\n    while b'\\r\\n\\r\\n' not in resp:\n        resp += s.recv(4096)\n    # Send text frame\n    payload = msg.encode()\n    frame = bytearray([0x81])\n    pl = len(payload)\n    if pl < 126:\n        frame.append(pl)\n    elif pl < 65536:\n        frame.extend([126] + list(struct.pack('!H', pl)))\n    else:\n        frame.extend([127] + list(struct.pack('!Q', pl)))\n    frame.extend(payload)\n    s.send(bytes(frame))\n    # Read response\n    data = s.recv(65536)\n    s.close()\n    if len(data) < 2: return ''\n    offset = 2\n    if data[1] & 0x80: offset += 4\n    return data[offset:].decode('utf-8', errors='replace')\nmsg = json.dumps({'jsonrpc':'2.0','id':'" + reqId + "','method':'execute','params':{'prompt':r'''" + prompt + "''','stream':true}})\nprint(ws_rpc(" + port + ", msg, " + timeoutSec + "))\n\""
      },
      jsonrpc_request: {
        jsonrpc: '2.0',
        id: String(reqId),
        method: 'execute',
        params: { prompt: prompt, stream: true }
      }
    });
  }

  async function wrap(f, p) {
    try {
      var r = await f(p);
      complete(r);
    } catch (e) {
      complete(err('异常: ' + e.message));
    }
  }

  return {
    codex_status: function(p) { return wrap(codex_status, p); },
    codex_start: function(p) { return wrap(codex_start, p); },
    codex_stop: function(p) { return wrap(codex_stop, p); },
    codex_call: function(p) { return wrap(codex_call, p); }
  };
})();

exports.codex_status = CodexBridge.codex_status;
exports.codex_start = CodexBridge.codex_start;
exports.codex_stop = CodexBridge.codex_stop;
exports.codex_call = CodexBridge.codex_call;