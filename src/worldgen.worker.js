import { generateWorld } from './worldgen.js';

self.onmessage = (e) => {
  const { seed } = e.data;
  const w = generateWorld(seed, (p) => self.postMessage({ type: 'progress', p }));
  const transfer = [w.heights.buffer, w.far.buffer, w.normals.buffer, w.mask.buffer, w.trees.buffer, w.blobs.buffer,
    w.shrubs.buffer, w.ferns.buffer, w.rocks.buffer, w.logs.buffer, w.cliff.buffer];
  self.postMessage({ type: 'done', world: w }, transfer);
};
