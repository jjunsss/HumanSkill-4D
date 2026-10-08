/* Inflate lossless Gaussian frame chunks away from pointer/timeline events.
   Contract: gaussian-sequence@1, 40-byte records, temporal uint32 XOR then 40 byte planes. */
const requests = new Map();
self.onmessage = async ({data}) => {
  const {id, cancel, file, count, frames} = data;
  if (cancel) { requests.get(id)?.abort(); return; }
  const controller = new AbortController();
  requests.set(id, controller);
  try {
    const response = await fetch(file, {signal: controller.signal, cache: 'force-cache'});
    if (!response.ok) throw Error(`Frame request failed (${response.status})`);
    const inflated = await new Response(response.body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
    const records = count * frames, size = records * 40;
    if (inflated.byteLength !== size) throw Error('Incomplete motion chunk');
    const planes = new Uint8Array(inflated), buffer = new ArrayBuffer(size), bytes = new Uint8Array(buffer);
    for (let b = 0; b < 40; b++) {
      const start = b * records;
      for (let i = 0; i < records; i++) bytes[i * 40 + b] = planes[start + i];
    }
    const words = new Uint32Array(buffer), stride = count * 10;
    for (let i = stride; i < words.length; i++) words[i] ^= words[i - stride];
    if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    self.postMessage({id, buffer}, [buffer]);
  } catch (error) {
    self.postMessage({id, error: error.message, aborted: error.name === 'AbortError'});
  } finally { requests.delete(id); }
};
