---
name: defensive-patterns
description: Use when a defect class occurs (or nearly occurs) for the 2nd time in ANY project, or once with a non-obvious mechanism — to consolidate it as a rule in the project's `docs/defensive-patterns.md`, so the whole class is prevented rather than the single instance fixed.
---

# Defensive Patterns（全局制度：坑类别固化）

规则文档**属于具体项目**（`docs/defensive-patterns.md`），制度全局适用。

## 写入门槛

某类缺陷真实发生过 **≥2 次**；或发生 1 次但**机制隐蔽、复现代价高**（此时通常还应配一篇 postmortem）。

## 首次在某项目使用时

创建 `docs/defensive-patterns.md`，头部写明"每条都是本项目真实踩过的缺陷类别"。

## 条目格式

```markdown
## N. <一句话规则>

机制是什么（为什么会发生，不显而易见的部分）；防护动作（必须做什么/绝不做什么）。
→ 关联：<postmortem 链接 / tracker / Agent Note>
```

要点：
- 标题就是**规则**（祈使句），不是现象描述
- 机制讲"为什么"，与 Agent Note（讲决策）和 postmortem（讲过程）区分
- 观测/工具类缺陷注意区分："证据获取失败 ≠ 证据内容为负"是常见根因模式
- 底部维护新增门槛说明

## 使用规则

- 修 bug 前先扫一遍该文档，命中类别就直接按防护动作做，不要重新推导
- 项目已有该文档 → 追加条目并编号顺延（如 limao-app 已有 8 条）
