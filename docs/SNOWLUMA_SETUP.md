# SnowLuma + transport-only 启动说明

## 目标

```text
QQ（个人号）
  → SnowLuma（OneBot v11 网关）
  → qq-bridge transport-only
  → platform-adapter /webhook/qq
  → DSH / memory / persona
  → adapter outbox
  → qq-bridge
  → QQ
```

qq-bridge **不登录 QQ、不启动 SnowLuma、不创建 DSH session**。

## 1. SnowLuma

按 SnowLuma 上游文档安装、启动并登录个人 QQ。

在 SnowLuma 中开启：

```text
OneBot WebSocket 服务端
OneBot HTTP API
```

记下：

```text
wsUrl
httpUrl
accessToken
```

具体端口以 SnowLuma 当前配置为准，例如 `ws://127.0.0.1:3001`、`http://127.0.0.1:3000`。

## 2. 复制配置

```powershell
Copy-Item config.example.json config.json
```

至少填写：

```json
{
  "adapter": {
    "baseUrl": "http://127.0.0.1:8788",
    "token": "<platform-adapter 的 inboundToken>",
    "pollMs": 1200,
    "maxImageBytes": 10485760
  },
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": "<SnowLuma accessToken>"
  }
}
```

`adapter.token` 来自 platform-adapter 当前 webhook token。改名完成后字段会统一迁移。

## 3. 启动

```powershell
npm run start:transport
```

成功时：

```text
[snowluma] connected
[snowluma] login <昵称> <QQ>
[bridge] transport-only started
```

状态文件：

```text
state/adapter-transport-status.json
```

以后控制台读这个文件，不从进程内存猜。

## 4. 测试顺序

```text
QQ 私聊 → 一条文本
QQ 群   → @ 一条文本
QQ 图片 → 查看 adapter 是否收到 image
```

按当前约定，这一阶段先不跑集成测试。

## 5. 已实现

```text
文本入站
群聊/私聊
@ 识别
第一条图片 base64 入站
文本出站
图片出站（kind=image）
文件出站（kind=file）
outbox ack
自身消息过滤
状态文件
```

## 6. 明确未实现

```text
qq-bridge 控制台接入
多端控制台
platform-adapter 改名
命令注册表
persona 注入
memory-server 对接
持久化消息队列
文件/语音完整媒体链路
```

## 7. 风险

- 个人 QQ 账号，存在设备锁/风控/封号风险
- SnowLuma 与 qq-bridge 是两个独立项目
- qq-bridge 当前是 PolyForm Noncommercial 1.0.0；个人非商业使用
- 不要把 `config.json`、token、SnowLuma 凭据提交到仓库
