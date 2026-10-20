// 作品 job 处理器注册（docs/ARCHITECTURE.md §4）。逐阶段扩充：
// project.understand（C2）→ bind_prompts（C4）→ segment.generate / gen.poll（C5）→ project.compose（C6）。
import { createBindPromptsHandler } from './bind.js';
import { createComposeHandler } from './compose.js';
import { createGenPollHandler, createSegmentGenerateHandler } from './segment.js';
import { createUnderstandHandler } from './understand.js';

export function createProjectHandlers({ db, logger, config, storyAgent, videoProvider, storage,
  render, downloadToTempFile, fetchLocal }) {
  return {
    'project.understand': createUnderstandHandler({ db, logger, storyAgent, config }),
    'project.bind_prompts': createBindPromptsHandler({ db, logger, storyAgent }),
    'segment.generate': createSegmentGenerateHandler({ db, logger, config, videoProvider }),
    'gen.poll': createGenPollHandler({ db, logger, config, videoProvider, storage, render, downloadToTempFile }),
    'project.compose': createComposeHandler({ db, logger, config, storage, render, fetchLocal }),
  };
}
