---
name: agent-notes
description: Use when making a long-term design/process decision, rejecting a seemingly-reasonable alternative, or introducing an external tool/mechanism with tradeoffs — in ANY project. Creates or updates `.agents/notes/` in the current repo following the standard format, so agents don't re-derive decisions from scratch.
---

# Agent Notes（全局制度：设计决策记录）

决策记录**属于具体项目**（放在该项目 `.agents/notes/`），但制度是全局的：任何项目里遇到符合条件的决策，都按本模板落地。

## 首次在某项目使用时

创建目录结构（路径即状态）：

```
.agents/notes/
├── README.md            # 从下方模板生成（去掉本节说明）
├── proposed/            # 实现前评审的提案
├── implemented/         # 已落地，按 class 分子目录
│   ├── architecture/ feature/ process/ testing/ bug-fix/ simplification/
├── rejected/            # 讨论后放弃（不删除，防止重新提出已否决方案）
└── archived/            # 被后续 Note 取代或失效
```

文件命名：`{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`

## 什么时候写

- 决策会**长期约束**后续改动（架构、流程、测试门禁）
- **否决了**看似合理的方案，理由不显而易见
- 引入外部机制（工具、扩展、脚本）且选型有取舍

不写：一次性 bugfix 过程、能从代码直接读出的内容。

## 文件格式

```markdown
# <标题>

Status: proposed | implemented | rejected | superseded by <链接>
Date: yyyy-mm-dd

## 决策
一两句话说清选了什么。

## 背景
为什么需要决策；约束是什么。

## 被否决的替代方案
- 方案 A — 为什么不行

## 后果（含负面）
落地后哪些事变容易/变难了。
```

## 使用规则

- 改动涉及某个有 Note 的区域 → 先读对应 Note 再动手
- 项目已有自己的 notes 目录/README（如 limao-app）→ 沿用项目版式，不重复创建
- 新 Note 写完把条目加进该项目的索引表（README 底部）
