---
name: postmortem
description: Use when a bug reached somewhere it shouldn't have (real device, merged PR, released build) in ANY project — to write a retrospective in `docs/postmortem/` analyzing why each safety net failed, not just the one-line fix. Only for incidents that are隐蔽 (non-obvious mechanism), 系统性 (process gap, not a typo), and costly to rediscover.
---

# Postmortem（全局制度：事故复盘）

复盘**属于具体项目**（放在该项目 `docs/postmortem/`），制度全局适用。

## 准入三条件（同时满足才写，否则记 commit message 即可）

1. **隐蔽** — 机制不显而易见，细心的工程师也得费力重新推导
2. **系统性** — 逃逸原因是测试/工具/约定的缺口，而非一次性笔误
3. **重新发现代价高** — 消耗了真实调试时间，且下次还会

## 首次在某项目使用时

创建 `docs/postmortem/README.md`（准入条件 + 索引表），然后写 `NNNN-short-title.md`。

## 文件格式

```markdown
# 事故复盘 NNNN：<标题>

Status: resolved | ongoing
Date: yyyy-mm-dd

## 摘要          ← 30 秒读完：什么坏了、直白说根因、为什么逃逸、长期教训
## 概述 / 时间线 / 根因
## 防护措施      ← 必须链接本事故催生的测试/规则/defensive-pattern 条目（✅已做 ⬜待办）
## 关联          ← 相关 tracker、同源事故家族
```

## 使用规则

- 复盘关注**为什么流程放过了它**，不是复述修复 diff
- 与 Agent Note 分工：Note 记决策（为什么选 X 弃 Y），postmortem 记失败（安全网为什么没拦住）
- 项目已有 postmortem 目录 → 沿用，编号顺延
