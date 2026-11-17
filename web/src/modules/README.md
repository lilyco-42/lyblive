# 前端模块约定（modules/）

`web/src/modules/` 放**可复用、可独立测试**的功能单元。与 `components/` 的区别：

| 目录 | 放什么 |
| --- | --- |
| `components/` | 页面级拼装与 shadcn 基础件（`ui/`） |
| `modules/` | 一个完整功能：配置 + 数据流 + 视图 + 设置 UI，自带出口 `index.ts` |

## 单模块结构（以 `danmu-overlay` 为例）

```
modules/danmu-overlay/
  config.ts              # 纯类型 + 纯函数（默认值 / 归一化 / 持久化 / URL 生成）
  useDanmuFeed.ts        # 数据流（SSE / 轮询），不依赖具体视图
  OverlayStage.tsx       # 渲染核心，只接收 props
  OverlaySettingsCard.tsx# 模块自带设置卡（宿主直接 <XxxSettingsCard />）
  OverlayView.tsx        # 独立页面（/overlay），透明背景
  index.ts               # 统一出口
```

## 契约

1. **config 必须纯**：不 import React，`normalize*` 对任何输入都要返回合法值（clamp 而非抛错），便于 Node 单测。
2. **数据流与视图分离**：hook 只产出数据（`items` / `seq` / `running` / `error`），不关心怎么画。
3. **设置 UI 跟着模块走**：新增模块时，把配置卡一并放在模块内，宿主页面只做一行引入。
4. **可选独立页面**：需要被 OBS / iframe / 新窗口直接打开的能力，提供 `XxxView` 并在 `main.tsx` 按 pathname 分流。
5. **不引入远端脚本**：浮层、二维码、广告位都只用同源资源（与商业化口径一致）。
6. **参数可被 URL 覆盖**：OBS 浏览器源与普通浏览器不共享 localStorage，URL query 必须能钉死配置。

## 已有模块

- `danmu-overlay`：弹幕漂浮（`/overlay`，OBS 浏览器源可用；`scroll` 飘屏 / `lyrics` 歌词两种模式）。