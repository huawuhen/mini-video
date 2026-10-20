// 作品 job 处理器注册（docs/ARCHITECTURE.md §4）。逐阶段扩充：
// project.understand（C2）→ bind_prompts（C4）→ segment.generate / gen.poll（C5）→ project.compose（C6）。
import { createUnderstandHandler } from './understand.js';

export function createProjectHandlers({ db, logger, config, storyAgent }) {
  return {
    'project.understand': createUnderstandHandler({ db, logger, storyAgent, config }),
  };
}
