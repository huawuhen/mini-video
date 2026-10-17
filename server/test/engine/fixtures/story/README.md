# 故事规划 LLM 样本夹具来源

这些样本只含虚构人物与剧情；不是实采用户故事或供应商生产响应。

- `normal.json`：按本项目 `docs/ARCHITECTURE.md` §5 的目标字段手写的理想输出。
- `fenced.txt`、`prose.txt`、`trailing-commas.txt`：按通用 LLM 常见输出形式（代码围栏、解释性前后文、尾逗号）手写。
- `missing-synopsis.txt`、`over-duration.txt`、`name-mismatch.txt`、`duplicate-voice.txt`、`type-drift.txt`：按 LLM 常见内容错误和本项目的时长、角色、声音约束手写。共 9 份。

超搭云 `2926b42` 的 screenwriter prompt 和 storyboard 规则仅作为提示词设计参考；没有把其会话、计费、仓库代码或真实模型响应复制进来。所有测试使用注入的脚本化模拟 LLM，零真实费用。
