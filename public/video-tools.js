(function (root) {
  'use strict';
  // Small pure helpers shared with Node tests. Visual-change scoring is not semantic analysis.
  function frameDifference(a, b) {
    if (!a || !b || a.length !== b.length || a.length === 0 || a.length % 4 !== 0) throw new Error('Invalid RGBA frames');
    let sum = 0;
    for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    return sum / (a.length / 4 * 3 * 255);
  }
  function normalizeCuts(cuts, duration) {
    return [...new Set(cuts.filter((n) => Number.isFinite(n)).map((n) => Math.round(n * 10) / 10).filter((n) => n > 0 && n < duration))].sort((a, b) => a - b).slice(0, 300);
  }
  function templateShots(duration, assetId, route) {
    const labels = ['开场钩子', '商品揭晓', '细节 / 使用场景', '收尾引导'];
    const ratios = [0, .2, .45, .8, 1];
    return labels.map((label, index) => ({
      start: Math.round(duration * ratios[index] * 10) / 10,
      end: Math.round(duration * ratios[index + 1] * 10) / 10,
      assetId: assetId || '',
      action: route === 'replace' ? `${label}：标注原片中的商品区域及遮挡；无法保真则用自有素材重建。` : `${label}：使用所选素材，描述镜头与真实可演示动作。`,
      copy: '', edit: '待根据参考节奏编辑'
    }));
  }
  const api = { frameDifference, normalizeCuts, templateShots };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VIDEO_TOOLS = api;
})(typeof window !== 'undefined' ? window : globalThis);
