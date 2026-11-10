import type {
  Platform,
  RejectionReason,
  SafeAreaPreset,
  TaskStatus,
} from "./types";

export const PLATFORM_LABELS: Record<Platform, string> = {
  douyin: "抖音",
  wechat_channels: "视频号",
  xiaohongshu: "小红书"
};

export const REJECTION_LABELS: Record<RejectionReason, string> = {
  not_debatable: "争议不足",
  incomplete: "表达不完整",
  off_brand: "偏离账号",
  duplicate: "内容重复",
  high_risk: "风险过高",
  rough_edit: "剪辑不顺"
};

export const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "排队中",
  paused: "已暂停",
  imported: "已导入",
  validating: "校验素材",
  analyzing: "分析话题",
  generating_candidates: "生成候选",
  generating_previews: "生成预览",
  awaiting_review: "待审核",
  rendering: "正在出片",
  exported: "已导出",
  failed: "处理失败"
};

export const DEFAULT_PLATFORM_SAFE_AREAS: Record<Platform, SafeAreaPreset> = {
  douyin: { top: 0.08, right: 0.08, bottom: 0.16, left: 0.08 },
  wechat_channels: { top: 0.08, right: 0.08, bottom: 0.14, left: 0.08 },
  xiaohongshu: { top: 0.08, right: 0.08, bottom: 0.15, left: 0.08 },
};

export const DEFAULT_SUBTITLE_TEMPLATE = {
  fontFamily: "Microsoft YaHei",
  fontSize: 58,
  primaryColor: "#FFFFFF",
  highlightColor: "#D8FF4F",
  outlineColor: "#101318",
  bottomMargin: 260
};

export const DEFAULT_CROP_PRESET = {
  topPercent: 0,
  rightPercent: 0,
  bottomPercent: 0.18,
  leftPercent: 0
};

export const ADMISSIONS_REVIEW_PRESET = "升学决策选题预设";

export function usesAdmissionsReviewPreset(selectionPrinciples?: string): boolean {
  return selectionPrinciples?.trim().split(/\r?\n/u, 1)[0] === ADMISSIONS_REVIEW_PRESET;
}
