// 统一错误类型（docs/API.md §0、§7）：响应体 { code, message, requestId, details? }，message 面向用户的中文。

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** 错误码 → [HTTP 状态, 默认中文提示]。新增错误码先改 docs/API.md §7。 */
export const ERROR_CODES = {
  VALIDATION_FAILED: [400, '填写的内容有误，请检查后重试'],
  STORY_TOO_SHORT: [400, '故事有点短，再多写几句吧'],
  STORY_TOO_LONG: [400, '故事太长了，请精简一些'],
  UPLOAD_TYPE_INVALID: [400, '文件格式不支持'],
  UPLOAD_TOO_LARGE: [400, '文件太大了'],
  SMS_CODE_INVALID: [400, '验证码错误或已过期'],
  UNAUTHENTICATED: [401, '请先登录'],
  INSUFFICIENT_BALANCE: [402, '余额不足，请先充值'],
  CSRF_INVALID: [403, '页面已过期，请刷新后重试'],
  NOT_FOUND: [404, '内容不存在或已被删除'],
  IDEMPOTENCY_CONFLICT: [409, '请求重复，请刷新后重试'],
  QUOTE_MISMATCH: [409, '价格有变化，请重新确认'],
  QUOTE_EXPIRED: [409, '报价已过期，请重新确认'],
  PROJECT_STATE_INVALID: [409, '作品当前状态不能进行这个操作，请刷新后重试'],
  VOICE_DUPLICATED: [409, '两个角色不能使用同一个声音'],
  WECHAT_OPENID_REQUIRED: [409, '微信内充值需要先完成授权'],
  PROJECT_EXPIRED: [410, '作品已过期，视频已清理'],
  CONTENT_REJECTED: [422, '内容未通过审核，请修改后重试'],
  RATE_LIMITED: [429, '操作太频繁，请稍后再试'],
  SMS_COOLDOWN: [429, '验证码发送太频繁，请稍后再试'],
  FREE_QUOTA_EXHAUSTED: [429, '今天的免费整理次数已用完，明天再来'],
  INTERNAL: [500, '服务器开小差了，请稍后再试'],
  NO_ACTIVE_CHANNEL: [503, '生成服务暂时不可用，请稍后再试'],
  ADMIN_AUTH_REQUIRED: [401, '请先登录管理后台'],
  CHANNEL_NOT_FOUND: [404, '渠道不存在'],
  DRIVER_NOT_FOUND: [400, '指定的协议驱动不存在'],
  CHANNEL_TEST_FAILED: [400, '渠道连接测试失败'],
  UPSTREAM_FAILED: [502, '生成服务暂时不可用，请稍后再试'],
  SUBMISSION_UNKNOWN: [502, '生成结果确认中，费用已冻结，请稍后查看'],
  PAYMENT_UNAVAILABLE: [502, '支付通道暂不可用，请稍后重试'],
  PHOTO_CONSENT_REQUIRED: [403, '上传照片前需要先同意照片使用说明'],
  // M3-ADM-02（API.md §8.1~8.2）：管理端用户/订单
  ACCOUNT_DISABLED: [403, '账号不可用，请联系客服 help@redith.cn'],
  ADJUST_EXCEEDS_BALANCE: [400, '可用余额不足，不能扣减这么多'],
  REFUND_EXCEEDS_BALANCE: [400, '用户可用余额不足，无法登记退款'],
  REFUND_EXCEEDS_ORDER: [400, '退款金额超过订单可退金额'],
  ORDER_NOT_PAID: [409, '订单未支付，不能登记退款'],
  USER_HAS_ACTIVE_PROJECTS: [409, '该用户还有进行中的作品，暂不能注销'],
  USER_NOT_FOUND: [404, '用户不存在'],
  ORDER_NOT_FOUND: [404, '订单不存在'],
};

/** 按错误码创建 AppError；message 省略时用默认中文提示。 */
export function appError(code, message, details) {
  const entry = ERROR_CODES[code];
  if (!entry) throw new Error(`未登记的错误码：${code}`);
  return new AppError(entry[0], code, message || entry[1], details);
}
