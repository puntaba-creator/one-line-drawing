// 重い計算（点のサンプリングと経路最適化）を UI スレッドから切り離す
import { generateOneStroke } from './lib/onestroke.js';

self.onmessage = (e) => {
  const { id, image, options } = e.data;
  try {
    let last = 0;
    const res = generateOneStroke(image, {
      ...options,
      onProgress(stage, ratio) {
        const now = Date.now();
        if (now - last > 50 || ratio === 1) {
          last = now;
          self.postMessage({ id, type: 'progress', stage, ratio });
        }
      },
    });
    self.postMessage({ id, type: 'result', result: res }, [res.points.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err?.message || err) });
  }
};
