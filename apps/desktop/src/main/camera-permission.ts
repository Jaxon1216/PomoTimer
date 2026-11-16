import { isRendererDocument } from "../shared/window-view.js";

// 领域：Electron / 摄像头权限
// 顺序：Session 权限检查或权限请求 -> allowsCameraPermission -> 视频授权结果。
// 作用：只允许启用监控后的主窗口主 frame 请求纯视频权限。
// 原因：规范化开发服务器 URL，并允许同一可信文档内的页面 fragment。
// 边界：不申请系统权限；缺失来源、音频和混合权限请求一律拒绝。
export function allowsCameraPermission(request: {
  enabled: boolean;
  permission: string;
  expectedContentsId: number;
  contentsId: number | undefined;
  isMainFrame: boolean;
  requestingUrl: string | undefined;
  rendererUrl: string;
  mediaTypes: readonly string[] | undefined;
}): boolean {
  if (!request.enabled || request.permission !== "media" || request.contentsId !== request.expectedContentsId
    || !request.isMainFrame || !request.requestingUrl
    || request.mediaTypes?.length !== 1 || request.mediaTypes[0] !== "video") return false;
  return isRendererDocument(request.requestingUrl, request.rendererUrl);
}
