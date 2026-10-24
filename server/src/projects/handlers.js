// 作品 job 处理器注册（docs/ARCHITECTURE.md §4）。逐阶段扩充：
// project.understand（C2）→ bind_prompts（C4）→ segment.generate / gen.poll（C5）→ project.compose（C6）。
// M2-BE-03：channelRouter 透传给各处理器（视频/图片/LLM 调用全部经渠道路由层；null = mock 直连注入）。
import { createBindPromptsHandler } from './bind.js';
import { createComposeHandler } from './compose.js';
import { createGenPollHandler, createSegmentGenerateHandler } from './segment.js';
import { createUnderstandHandler } from './understand.js';

export function createProjectHandlers({ db, logger, config, storyAgent, videoProvider, storage,
  render, downloadToTempFile, fetchLocal, channelRouter = null }) {
  return {
    'project.understand': createUnderstandHandler({ db, logger, storyAgent, config, channelRouter }),
    'project.bind_prompts': createBindPromptsHandler({ db, logger, storyAgent, channelRouter }),
    'segment.generate': createSegmentGenerateHandler({ db, logger, config, videoProvider, storage, storyAgent, channelRouter }),
    'gen.poll': createGenPollHandler({ db, logger, config, videoProvider, storage, render, downloadToTempFile, channelRouter }),
    'project.compose': createComposeHandler({ db, logger, config, storage, render, fetchLocal }),
  };
}
