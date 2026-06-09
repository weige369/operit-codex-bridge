/*
METADATA
{
    "name": "CodexBridge",
    "display_name": { "zh": "Codex CLI 桥接", "en": "Codex CLI Bridge" },
    "description": { "zh": "在 Android 设备上通过 proot 启动 Codex CLI exec-server，提供 WebSocket 代理实现 AI 编码辅助。", "en": "Start Codex CLI exec-server on Android via proot, with WebSocket proxy for AI coding assistance." },
    "category": "Development",
    "tools": [
        { "name": "codex_status", "description": { "zh": "检查 Codex exec-server 运行状态", "en": "Check Codex exec-server status" }, "parameters": [] },
        { "name": "codex_start", "description": { "zh": "启动 Codex exec-server", "en": "Start Codex exec-server" }, "parameters": [ { "name": "port", "description": "WebSocket 端口 (默认 9877)", "type": "integer", "required": false }, { "name": "data_dir", "description": "数据目录 (默认 /sdcard/codex-data)", "type": "string", "required": false } ] },
        { "name": "codex_stop", "description": { "zh": "停止 Codex exec-server", "en": "Stop Codex exec-server" }, "parameters": [] },
        { "name": "codex_execute", "description": { "zh": "向 Codex 发送 prompt 并获取响应", "en": "Send prompt to Codex and get response" }, "parameters": [ { "name": "prompt", "description": "prompt 文本", "type": "string", "required": true }, { "name": "stream", "description": "流式输出 (默认 true)", "type": "boolean", "required": false }, { "name": "timeout_ms", "description": "超时毫秒 (默认 60000)", "type": "integer", "required": false } ] },
        { "name": "codex_install", "description": { "zh": "下载并安装 Codex CLI 二进制", "en": "Download and install Codex CLI binary" }, "parameters": [ { "name": "version", "description": "版本号 (默认最新)", "type": "string", "required": false }, { "name": "data_dir", "description": "数据目录", "type": "string", "required": false }, { "name": "force", "description": "强制重装", "type": "boolean", "required": false } ] }
    ]
}
*/

var CodexBridge = (function() {
  'use strict';

  // ═══════════════════════════════════════
  // 配置常量
  // ═══════════════════════════════════════
  var DEFAULT_PORT = 9877;
  var DEFAULT_DATA_DIR = '/sdcard/codex-data';
  var CODEX_RELEASES_API = 'https://api.github.com/repos/openai/codex/releases?per_page=30';
  var CODEX_BINARY_NAME = 'codex';
  var DEFAULT_TIMEOUT_MS = 60000;

  // 运行时状态
  var state = {
    running: false,
    port: DEFAULT_PORT,
    pid: null,
    mode: null, // "shizuku" | "root" | "direct"
    dataDir: DEFAULT_DATA_DIR,
    version: null
  };

  // ═══════════════════════════════════════
  // 辅助函数
  // ═══════════════════════════════════════
  function err(m) { return { success: false, message: '[CodexBridge] ' + m }; }
  function ok(d) { var r = { success: true }; for (var k in d) r[k] = d[k]; return r; }

  /**
   * 在 Android shell 中执行命令（通过 Shizuku shell domain）
   * 利用 Operit 已有的 super_admin:shell 能力
   */
  function shell(cmd) {
    // 通过 host runtime 调用 shell
    // 这里返回一个 Promise，由外部桥接层处理
    return _execShell(cmd);
  }

  /**
   * 获取设备 CPU 架构
   */
  function _detectArch() {
    var cmd = 'uname -m';
    var result = _execShellSync(cmd);
    var arch = (result || '').trim();
    if (arch === 'aarch64') return { abi: 'arm64-v8a', rustTarget: 'aarch64-unknown-linux-musl' };
    if (arch === 'x86_64') return { abi: 'x86_64', rustTarget: 'x86_64-unknown-linux-musl' };
    if (arch === 'armv7l' || arch === 'armv8l') return { abi: 'armeabi-v7a', rustTarget: 'armv7-unknown-linux-musleabihf' };
    return null;
  }

  // ═══════════════════════════════════════
  // codex_status — 检查运行状态
  // ═══════════════════════════════════════
  async function codex_status(p) {
    try {
      var port = state.port;
      // 检查端口是否监听
      var ssResult = _execShellSync('ss -ltnp 2>/dev/null | grep ' + port + ' || netstat -tlnp 2>/dev/null | grep ' + port);
      var listening = ssResult && ssResult.indexOf('LISTEN') !== -1;

      // 检查 codex 进程
      var psResult = _execShellSync('ps -A 2>/dev/null | grep codex || echo "no-process"');
      var hasProcess = psResult && psResult.indexOf('codex') !== -1 && psResult.indexOf('no-process') === -1;

      if (listening && hasProcess) {
        state.running = true;
        return ok({
          status: 'running',
          port: port,
          listening: true,
          mode: state.mode || 'unknown',
          version: state.version || 'unknown',
          pid_info: psResult.trim()
        });
      } else if (listening && !hasProcess) {
        return ok({
          status: 'partial',
          port: port,
          listening: true,
          process_alive: false,
          note: '端口在监听但未检测到 codex 进程，可能由其他进程占用'
        });
      } else {
        state.running = false;
        return ok({
          status: 'stopped',
          port: port,
          listening: false,
          process_alive: hasProcess
        });
      }
    } catch (e) {
      return err('状态检查失败: ' + e.message);
    }
  }

  // ═══════════════════════════════════════
  // codex_start — 启动 exec-server
  // ═══════════════════════════════════════
  async function codex_start(p) {
    try {
      var port = p.port || DEFAULT_PORT;
      var dataDir = p.data_dir || DEFAULT_DATA_DIR;
      state.port = port;
      state.dataDir = dataDir;

      // 先检查是否已在运行
      var status = await codex_status({});
      if (status.success && status.status === 'running') {
        return ok({ message: 'Codex exec-server 已在运行', port: port, status: 'already_running' });
      }

      var rootfs = dataDir + '/linux-rootfs';
      var libDir = dataDir + '/native-libs';
      var codexBin = rootfs + '/usr/local/bin/codex';

      // 检查 rootfs 和 codex 是否存在
      var checkRootfs = _execShellSync('test -d ' + rootfs + ' && echo "ok" || echo "missing"');
      if (checkRootfs.indexOf('missing') !== -1) {
        return err('rootfs 不存在: ' + rootfs + '。请先运行 codex_install 安装。');
      }

      var checkBin = _execShellSync('test -x ' + codexBin + ' && echo "ok" || echo "missing"');
      if (checkBin.indexOf('missing') !== -1) {
        return err('Codex 二进制不存在: ' + codexBin + '。请先运行 codex_install 安装。');
      }

      // 查找 libproot.so
      var libprootPath = _findLibproot(libDir);

      // 构建启动脚本（与 codex-android-dev 一致的逻辑）
      var script = [
        '#!/system/bin/sh',
        'export LD_LIBRARY_PATH=' + libDir,
        'export PROOT_LOADER=' + libDir + '/libproot-loader.so',
        'export PROOT_TMP_DIR=' + dataDir + '/tmp',
        'mkdir -p ' + dataDir + '/tmp',
        'exec ' + libprootPath,
        ' --rootfs=\'' + rootfs + '\'',
        ' --root-id --kill-on-exit',
        ' -b /dev -b /proc -b /sys -b /storage',
        ' -w /root',
        ' /usr/bin/env -i',
        ' HOME=/root',
        ' PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        ' TERM=xterm-256color LANG=C.UTF-8 SHELL=/bin/bash USER=root',
        ' /bin/bash -c',
        ' \'/usr/local/bin/codex exec-server --listen ws://0.0.0.0:' + port + '\''
      ].join('\n');

      var scriptFile = dataDir + '/start_codex.sh';
      _writeFile(scriptFile, script);
      _execShellSync('chmod +x ' + scriptFile);

      // 三层 fallback: Shizuku → Root → 直接执行
      var started = false;
      var mode = '';

      // 1. 尝试 Shizuku shell domain
      try {
        var shizukuResult = _execShellSync('sh ' + scriptFile + ' > ' + dataDir + '/codex.log 2>&1 &');
        // 如果 execShell 走的是 Shizuku（shell domain），ptrace 可用
        started = true;
        mode = 'shizuku';
      } catch (e) {
        // Shizuku 不可用
      }

      // 2. 如果 Shizuku 不可用，尝试 Root
      if (!started) {
        try {
          _execShellSync('su -c "nohup sh ' + scriptFile + ' > ' + dataDir + '/codex.log 2>&1 &"');
          started = true;
          mode = 'root';
        } catch (e) {
          // Root 不可用
        }
      }

      // 3. 最后尝试直接后台执行
      if (!started) {
        _execShellSync('nohup sh ' + scriptFile + ' > ' + dataDir + '/codex.log 2>&1 &');
        mode = 'direct';
        started = true;
      }

      state.running = true;
      state.mode = mode;

      // 等待端口就绪
      var maxWait = 15; // 最多等 15 秒
      var waited = 0;
      while (waited < maxWait) {
        _sleepSync(1000);
        waited++;
        var check = _execShellSync('ss -ltnp 2>/dev/null | grep ' + port + ' | grep LISTEN || echo ""');
        if (check.indexOf('LISTEN') !== -1) {
          return ok({
            message: 'Codex exec-server 启动成功',
            port: port,
            mode: mode,
            waited_seconds: waited
          });
        }
      }

      return ok({
        message: '已尝试启动，但端口尚未就绪（已等待 ' + waited + ' 秒）。请稍后运行 codex_status 检查。',
        port: port,
        mode: mode,
        log_file: dataDir + '/codex.log'
      });

    } catch (e) {
      return err('启动失败: ' + e.message);
    }
  }

  // ═══════════════════════════════════════
  // codex_stop — 停止 exec-server
  // ═══════════════════════════════════════
  async function codex_stop(p) {
    try {
      // 先杀 codex 进程
      _execShellSync('pkill -f "codex exec-server" 2>/dev/null || true');
      // 再杀 proot 进程
      _execShellSync('pkill -f "libproot" 2>/dev/null || true');
      // 释放端口
      _execShellSync('fuser -k ' + state.port + '/tcp 2>/dev/null || true');

      state.running = false;
      state.pid = null;
      state.mode = null;

      return ok({ message: 'Codex exec-server 已停止', port: state.port });
    } catch (e) {
      return err('停止失败: ' + e.message);
    }
  }

  // ═══════════════════════════════════════
  // codex_execute — 发送 prompt 获取响应
  // ═══════════════════════════════════════
  async function codex_execute(p) {
    try {
      var prompt = p.prompt;
      if (!prompt) return err('prompt 参数不能为空');

      var timeoutMs = p.timeout_ms || DEFAULT_TIMEOUT_MS;
      var stream = p.stream !== undefined ? p.stream : true;

      // 确保服务器在运行
      var status = await codex_status({});
      if (!status.success || (status.status !== 'running' && status.status !== 'partial')) {
        return err('Codex exec-server 未运行。请先执行 codex_start。');
      }

      // 构建 JSON-RPC 请求
      var requestId = 'cb_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      var request = JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method: 'execute',
        params: {
          prompt: prompt,
          stream: stream
        }
      });

      // 通过 WebSocket 发送（使用 curl 兼容方式通过 HTTP 桥接）
      // 注意：这里如果 Operit 环境支持 WebSocket client，优先使用 WebSocket
      var wsUrl = 'ws://127.0.0.1:' + state.port;

      // 尝试用 websocat 或 python websocket 客户端
      var response = _wsSendReceive(wsUrl, request, timeoutMs);

      if (response) {
        try {
          var parsed = JSON.parse(response);
          return ok({
            request_id: requestId,
            response: parsed,
            stream: stream
          });
        } catch (e) {
          return ok({
            request_id: requestId,
            raw_response: response,
            stream: stream
          });
        }
      }

      return err('未收到响应（超时 ' + timeoutMs + 'ms）');

    } catch (e) {
      return err('执行失败: ' + e.message);
    }
  }

  // ═══════════════════════════════════════
  // codex_install — 下载安装 Codex
  // ═══════════════════════════════════════
  async function codex_install(p) {
    try {
      var dataDir = p.data_dir || DEFAULT_DATA_DIR;
      var force = p.force || false;
      state.dataDir = dataDir;

      _execShellSync('mkdir -p ' + dataDir + '/native-libs ' + dataDir + '/linux-rootfs/usr/local/bin ' + dataDir + '/tmp');

      // 检查是否已安装
      var codexBin = dataDir + '/linux-rootfs/usr/local/bin/codex';
      var alreadyInstalled = _execShellSync('test -x ' + codexBin + ' && echo "ok" || echo "no"');

      if (alreadyInstalled.indexOf('ok') !== -1 && !force) {
        // 获取已安装版本
        var installedVer = _execShellSync(codexBin + ' --version 2>/dev/null || echo "unknown"');
        return ok({
          message: 'Codex 已安装',
          version: installedVer.trim(),
          path: codexBin,
          action: 'skipped'
        });
      }

      // 获取最新版本信息
      var arch = _detectArch();
      if (!arch) return err('无法识别设备 CPU 架构');

      // 从 GitHub API 获取最新 release
      var releaseInfo = _httpGetJson(CODEX_RELEASES_API);
      if (!releaseInfo || !Array.isArray(releaseInfo) || releaseInfo.length === 0) {
        return err('无法获取 Codex release 信息，请检查网络');
      }

      // 查找匹配当前架构的 musl 静态链接产物
      var targetPattern = arch.rustTarget;
      var targetRelease = null;
      var targetAsset = null;

      for (var i = 0; i < releaseInfo.length; i++) {
        var rel = releaseInfo[i];
        var assets = rel.assets || [];
        for (var j = 0; j < assets.length; j++) {
          var asset = assets[j];
          var name = asset.name || '';
          if (name.indexOf(targetPattern) !== -1 && name.indexOf('.tar.gz') !== -1) {
            targetRelease = rel;
            targetAsset = asset;
            break;
          }
        }
        if (targetAsset) break;
      }

      if (!targetAsset) {
        return err('未找到适配 ' + targetPattern + ' 的 Codex 产物');
      }

      var version = targetRelease.tag_name || 'unknown';
      var downloadUrl = targetAsset.browser_download_url;
      var tarball = dataDir + '/codex.tar.gz';

      // 下载
      var downloadResult = _execShellSync(
        'curl -L --connect-timeout 30 --max-time 300 -o ' + tarball + ' "' + downloadUrl + '" 2>&1 && echo "DOWNLOAD_OK" || echo "DOWNLOAD_FAIL"'
      );

      if (downloadResult.indexOf('DOWNLOAD_FAIL') !== -1) {
        return err('下载失败: ' + downloadUrl);
      }

      // 解压到 rootfs
      var extractDir = dataDir + '/codex-extract';
      _execShellSync('rm -rf ' + extractDir + ' && mkdir -p ' + extractDir);
      _execShellSync('tar -xzf ' + tarball + ' -C ' + extractDir);

      // 查找 codex 二进制
      var findResult = _execShellSync('find ' + extractDir + ' -name "codex" -type f 2>/dev/null | head -1');
      var foundBin = (findResult || '').trim();

      if (!foundBin) {
        return err('解压后未找到 codex 二进制');
      }

      // 复制到 rootfs
      _execShellSync('cp ' + foundBin + ' ' + codexBin + ' && chmod +x ' + codexBin);

      // 清理
      _execShellSync('rm -rf ' + tarball + ' ' + extractDir);

      state.version = version;

      return ok({
        message: 'Codex CLI 安装完成',
        version: version,
        path: codexBin,
        arch: targetPattern,
        action: 'installed'
      });

    } catch (e) {
      return err('安装失败: ' + e.message);
    }
  }

  // ═══════════════════════════════════════
  // 内部辅助函数（由 Operit 桥接层提供实现）
  // ═══════════════════════════════════════

  function _execShellSync(cmd) {
    // 通过 Android shell (Shizuku domain) 同步执行
    // 实际由 Operit 运行时的 super_admin:shell 提供
    if (typeof _hostExecShellSync === 'function') {
      return _hostExecShellSync(cmd);
    }
    // fallback: 通过 Java bridge
    return _javaShellExec(cmd);
  }

  function _execShell(cmd) {
    return new Promise(function(resolve, reject) {
      if (typeof _hostExecShell === 'function') {
        _hostExecShell(cmd).then(resolve).catch(reject);
      } else {
        try {
          var result = _javaShellExec(cmd);
          resolve(result);
        } catch (e) {
          reject(e);
        }
      }
    });
  }

  function _javaShellExec(cmd) {
    // 通过 Java/Android shell bridge
    // 在 Operit 环境中由内置的 shell 工具提供
    try {
      if (typeof Shell !== 'undefined' && Shell.exec) {
        return Shell.exec(cmd);
      }
    } catch (e) {}
    return '';
  }

  function _writeFile(path, content) {
    try {
      if (typeof _hostWriteFile === 'function') {
        _hostWriteFile(path, content);
        return;
      }
    } catch (e) {}
    // fallback: echo to file
    _execShellSync('cat > ' + path + " << 'CEOF'\n" + content + '\nCEOF');
  }

  function _sleepSync(ms) {
    var end = Date.now() + ms;
    while (Date.now() < end) {}
  }

  function _findLibproot(libDir) {
    // 尝试多个可能的路径
    var candidates = [
      libDir + '/libproot.so',
      '/data/data/com.codex.android/files/native-libs/libproot.so',
      '/data/app/com.codex.android-*/lib/arm64/libproot.so'
    ];

    for (var i = 0; i < candidates.length; i++) {
      var check = _execShellSync('test -f ' + candidates[i] + ' && echo "ok" || echo "no"');
      if (check.indexOf('ok') !== -1) {
        return candidates[i];
      }
    }

    // 默认返回
    return libDir + '/libproot.so';
  }

  function _httpGetJson(url) {
    try {
      var result = _execShellSync('curl -s --connect-timeout 10 --max-time 15 "' + url + '" 2>/dev/null');
      if (result) {
        return JSON.parse(result);
      }
    } catch (e) {}
    return null;
  }

  function _wsSendReceive(wsUrl, message, timeoutMs) {
    // 使用 Python 的 websocket-client（常见于 proot 环境）
    // 或使用 websocat
    var tmpFile = state.dataDir + '/ws_request_' + Date.now() + '.txt';
    var tmpResponse = state.dataDir + '/ws_response_' + Date.now() + '.txt';

    _writeFile(tmpFile, message);

    // 尝试 websocat
    var cmd = 'cat ' + tmpFile + ' | websocat -n1 --timeout ' + Math.floor(timeoutMs / 1000) + ' ' + wsUrl + ' > ' + tmpResponse + ' 2>/dev/null && echo "OK" || echo "FAIL"';
    var result = _execShellSync(cmd);

    if (result.indexOf('OK') !== -1) {
      var response = _execShellSync('cat ' + tmpResponse + ' 2>/dev/null');
      _execShellSync('rm -f ' + tmpFile + ' ' + tmpResponse);
      return response;
    }

    // 尝试 Python websocket
    var pyScript = [
      'import sys, json',
      "with open('" + tmpFile + "', 'r') as f:",
      '    msg = f.read()',
      'try:',
      '    import websocket',
      '    ws = websocket.create_connection("' + wsUrl + '", timeout=' + Math.floor(timeoutMs / 1000) + ')',
      '    ws.send(msg)',
      '    resp = ws.recv()',
      '    ws.close()',
      "    with open('" + tmpResponse + "', 'w') as f:",
      '        f.write(resp)',
      '    print("OK")',
      'except Exception as e:',
      '    print("FAIL: " + str(e))'
    ].join('\n');

    var pyFile = state.dataDir + '/ws_client.py';
    _writeFile(pyFile, pyScript);
    var pyResult = _execShellSync('python3 ' + pyFile + ' 2>/dev/null');
    _execShellSync('rm -f ' + pyFile);

    if (pyResult.indexOf('OK') !== -1) {
      var response = _execShellSync('cat ' + tmpResponse + ' 2>/dev/null');
      _execShellSync('rm -f ' + tmpFile + ' ' + tmpResponse);
      return response;
    }

    _execShellSync('rm -f ' + tmpFile + ' ' + tmpResponse + ' ' + pyFile);
    return null;
  }

  // ═══════════════════════════════════════
  // 包装函数 + 导出
  // ═══════════════════════════════════════
  async function wrap(f, p) {
    try {
      var r = await f(p);
      complete(r);
    } catch (e) {
      complete(err('执行异常: ' + e.message));
    }
  }

  return {
    codex_status: function(p) { return wrap(codex_status, p); },
    codex_start: function(p) { return wrap(codex_start, p); },
    codex_stop: function(p) { return wrap(codex_stop, p); },
    codex_execute: function(p) { return wrap(codex_execute, p); },
    codex_install: function(p) { return wrap(codex_install, p); }
  };
})();

exports.codex_status = CodexBridge.codex_status;
exports.codex_start = CodexBridge.codex_start;
exports.codex_stop = CodexBridge.codex_stop;
exports.codex_execute = CodexBridge.codex_execute;
exports.codex_install = CodexBridge.codex_install;