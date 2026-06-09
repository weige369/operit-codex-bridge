# Codex Bridge

Operit Sandbox Package — 在 Android 设备上通过 proot 启动 OpenAI Codex CLI exec-server，提供 WebSocket 代理实现 AI 编码辅助。

## 背景

`codex-android-dev` 项目尝试将 Codex CLI 打包为 Android APK，通过 WebView + WebSocket 提供交互界面。但在调通过程中发现：

- Android `untrusted_app` SELinux domain 不允行 `ptrace`（proot 依赖 ptrace）
- 只能通过 Shizuku（shell domain）或 Root 启动 proot
- WebView 前端 CORS 策略与打包 SPA 存在大量兼容性问题

而 **Operit 本身已经解决了这些问题**——内置 Shizuku 集成、shell domain 执行能力、WebSocket 通信基础设施。

## 包功能

| 工具 | 说明 |
|---|---|
| `codex_install` | 从 GitHub Releases 下载 Codex CLI 二进制，放入 rootfs |
| `codex_start` | 通过 proot 启动 exec-server（Shizuku→Root→直接 三层 fallback） |
| `codex_stop` | 停止 exec-server |
| `codex_status` | 检查端口/进程状态 |
| `codex_execute` | 通过 WebSocket 发送 prompt 获取 AI 响应 |

## 前置要求

1. **Operit App** — 已安装并授权 Shizuku
2. **Linux rootfs** — 放置在 `{data_dir}/linux-rootfs/`（Ubuntu/Debian 等）
3. **libproot.so** — 放置在 `{data_dir}/native-libs/`（或复用 codex-android-dev 提取的）
4. **网络** — 能访问 GitHub API 下载 Codex 二进制

## 安装

### 方式一：放入 dev_package 目录

```bash
cp -r packages/codex-bridge /sdcard/Download/Operit/dev_package/
```

然后在 Operit 中启用包。

### 方式二：通过 Git 分发

```bash
git clone https://github.com/weige369/operit-codex-bridge.git
cp -r operit-codex-bridge/packages/codex-bridge /sdcard/Download/Operit/dev_package/
```

## 使用

在 Operit 对话中：

```
> 帮我启动 Codex
AI: 调用 codex_start → exec-server 启动在 9877 端口

> 用 Codex 帮我分析这段代码为什么报错
AI: 调用 codex_execute → 发送 prompt → 返回 Codex 分析结果
```

## 仓库结构

```
operit-codex-bridge/
├── README.md
├── packages/
│   └── codex-bridge/
│       ├── codex-bridge.js    # 核心包代码
│       └── package.json       # 包元数据（可选）
└── scripts/
    └── setup.sh               # 一键环境搭建脚本（计划中）
```

## 与 codex-android-dev 的关系

本仓库是 `codex-android-dev` 的精神延续——核心逻辑（proot 启动、WebSocket 连接、JSON-RPC 通信）直接继承自该项目的 `CodexRuntimeService.kt` 和 `CodexBridge.kt`，但：

- 不再需要 Android 原生开发（Kotlin/Gradle/Compose）
- 不再需要 WebView 前端
- 不再需要打包 APK
- 直接利用 Operit 已有的基础设施

## License

MIT