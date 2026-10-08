/* On-demand native motion frames. At most five decoded chunks and two requests
   are held; clip changes terminate the worker and release the entire cache. */
(() => {
  'use strict';
  const workerURL = new URL('sequence-worker.js', document.currentScript.src);
  class GaussianSequence {
    constructor(spec) {
      if (spec.schema !== 'gaussian-sequence@1' || spec.codec !== 'xor-byteplane-deflate' || spec.stride !== 40)
        throw Error('Unsupported motion sequence');
      if (!window.Worker || !window.DecompressionStream) throw Error('3D motion needs a newer browser. The video is still available.');
      this.spec = spec;
      this.cache = new Map();
      this.pending = new Map();
      this.queue = [];
      this.serial = 0;
      this.closed = false;
      this.worker = new Worker(workerURL);
      this.worker.onmessage = ({data}) => {
        const entry = [...this.pending.values()].find(item => item.id === data.id);
        if (!entry) return;
        this.pending.delete(entry.index);
        if (data.error) entry.reject(new Error(data.error));
        else {
          this.cache.delete(entry.index);
          this.cache.set(entry.index, data.buffer);
          while (this.cache.size > 5) this.cache.delete(this.cache.keys().next().value);
          entry.resolve(data.buffer);
        }
        this.pump();
      };
      this.worker.onerror = () => this.close(new Error('Could not load 3D motion. Return to the video and try again.'));
    }
    index(frame) {
      return Math.floor((Math.max(this.spec.first, Math.min(frame, this.spec.end - 1)) - this.spec.first) / this.spec.chunkFrames);
    }
    peek(frame) {
      const index = this.index(frame), buffer = this.cache.get(index);
      if (!buffer) return null;
      this.cache.delete(index); this.cache.set(index, buffer);
      const chunk = this.spec.chunks[index], stride = this.spec.count * 40;
      return new Uint8Array(buffer, (frame - chunk.first) * stride, stride);
    }
    request(index, urgent = false) {
      if (this.closed) return Promise.reject(new Error('Motion closed'));
      if (this.cache.has(index)) return Promise.resolve(this.cache.get(index));
      let entry = this.pending.get(index) || this.queue.find(item => item.index === index);
      if (!entry) {
        entry = {index, id: ++this.serial};
        entry.promise = new Promise((resolve, reject) => Object.assign(entry, {resolve, reject}));
        this.queue.push(entry);
      }
      if (urgent) {
        this.queue = this.queue.filter(item => item !== entry);
        if (!this.pending.has(index)) this.queue.unshift(entry);
      }
      this.pump();
      return entry.promise;
    }
    pump() {
      while (!this.closed && this.pending.size < 2 && this.queue.length) {
        const entry = this.queue.shift(), chunk = this.spec.chunks[entry.index];
        this.pending.set(entry.index, entry);
        this.worker.postMessage({id: entry.id, file: new URL(chunk.file, document.baseURI).href,
          count: this.spec.count, frames: chunk.frames});
      }
    }
    async frame(frame) {
      const index = this.index(frame);
      // Fast scrubs discard obsolete work instead of building a long download queue.
      const keep = new Set([index, (index + 1) % this.spec.chunks.length, (index + 2) % this.spec.chunks.length]);
      this.queue = this.queue.filter(entry => {
        if (keep.has(entry.index)) return true;
        entry.reject(new Error('Frame request superseded')); return false;
      });
      for (const entry of [...this.pending.values()]) if (!keep.has(entry.index)) {
        this.worker.postMessage({id: entry.id, cancel: true});
        this.pending.delete(entry.index);
        entry.reject(new Error('Frame request superseded'));
      }
      const buffer = await this.request(index, true);
      const chunk = this.spec.chunks[index], stride = this.spec.count * 40;
      return new Uint8Array(buffer, (frame - chunk.first) * stride, stride);
    }
    prefetch(frame) {
      const index = this.index(frame);
      for (let ahead = 1; ahead <= 2; ahead++) this.request((index + ahead) % this.spec.chunks.length).catch(() => {});
    }
    close(error = new Error('Motion closed')) {
      this.closed = true;
      this.worker.terminate();
      for (const entry of [...this.pending.values(), ...this.queue]) entry.reject(error);
      this.pending.clear(); this.queue = []; this.cache.clear();
    }
  }
  window.GaussianSequence = GaussianSequence;
})();
