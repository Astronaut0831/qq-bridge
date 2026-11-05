# Unified QQ Transport Decisions

状态：进行中，未验收。当前只完成了 transport-only 入口，不代表整个方案完成。

## 已定目标

```text
一个 platform-adapter
  ├─ 微信 bridge
  ├─ QQ bridge（SnowLuma OneBot，个人号）
  └─ 后续平台
        ↓
   DSH / memory-server / persona
```

QQ 不再使用官方 dsh-qqbot；改用个人 QQ + SnowLuma OneBot。
qq-bridge 只做 transport，不做第二套 agent。

## 保留

```text
微信 bridge / 微信现有链路
platform-adapter（即将由 wechat-adapter 改名）
adapter 的路由、scope、group policy、judge、outbox
DSH GUI/headless
memory-server
personas/whale-agent.md
微信/QQ 主人私聊共用记忆
群聊隔离
```

## 借鉴 qq-bridge

```text
SnowLuma OneBot 连接
OneBot 媒体解析/下载
控制台布局与移动端适配
健康检查
消息排队/补投
日志与用量面板
人格卡的分块/预览思路
```

控制台后端必须改为调用 platform-adapter，而不是 qq-bridge 自己的 DSH session。

## 砍掉

```text
qq-bridge 自己的 DSH session/agent loop
qq-chat / qq-chat-v2 preset
qq-bridge 的 role-card 注入执行（只借鉴卡片形式）
qq-bridge 的 social memory（activeTopic / pendingThought / memberImpression）
reserved / reserved2 / closed-agent 仿真模式
wake/sleep 状态机
qq_memory_* 社交记忆工具
后台 agent（/agent）
/ls /sendfile /dl /run（由 agent 工具替代）
```

## 记忆（未定）

尚未决定是否移植五层记忆语义。当前 transport-only 不碰 memory-server，只把消息交给 adapter。

待讨论：

```text
短期 72h 淡出
命中两次晋升长期
隐藏区 / 随机回想
记忆权重与预算
```

## 命令（先记录，暂不改）

动态 `/help`：

```text
命令注册表 + platform/scope/capabilities 过滤
surface=chat|console
```

前端控制台：

```text
/listen
/online
/offline
/persona
```

聊天命令保留：

```text
help status mute unmute talk corpus proactive care
remind behavior pref facts memory backup task set digest usage
```

删除：

```text
agent
ls sendfile dl run
```

## 当前已实现的 qq-bridge 改动

```text
src/adapter-transport.js
  SnowLuma WS -> POST /webhook/qq
  GET /api/bridge/outbox?platform=qq -> SnowLuma send
  text / first image / ack / self-echo filter

config.example.json: adapter 段
package.json: start:transport
```

## 下一步实现顺序

1. transport：媒体出站、错误重试、健康状态
2. platform-adapter 改名与命令注册表
3. qq-bridge 控制台接 platform-adapter
4. persona 接入（使用现有 whale-agent.md）
5. 记忆方案（等讨论结论）
