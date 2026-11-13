// No IndexedDB, local/session storage, audio download or public URL. A single
// encrypted recording and non-exportable per-capture key live in this tab only.
export function createDiagnosticVault({cryptoImpl = globalThis.crypto, clock = Date.now, schedule = setTimeout, cancel = clearTimeout, onDelete = () => {}} = {}) {
  let key, ciphertext, iv, expiresAt = 0, timer, generation = 0;
  function erase(reason = 'deleted') {
    generation++; cancel(timer); timer = undefined;
    if (ciphertext) new Uint8Array(ciphertext).fill(0);
    iv?.fill(0); key = ciphertext = iv = undefined; expiresAt = 0;
    onDelete(reason);
  }
  function available() { if (expiresAt && clock() >= expiresAt) erase('expired'); return Boolean(key && ciphertext); }
  return {
    async retain(bytes, deadline) {
      erase('replaced'); const current = generation;
      if (!Number.isFinite(deadline) || deadline <= clock() || deadline > clock() + 30*60*1000) throw Error('Invalid diagnostic deadline');
      const nextKey = await cryptoImpl.subtle.generateKey({name:'AES-GCM',length:256}, false, ['encrypt','decrypt']);
      const nextIv = cryptoImpl.getRandomValues(new Uint8Array(12));
      const encrypted = await cryptoImpl.subtle.encrypt({name:'AES-GCM',iv:nextIv}, nextKey, bytes);
      if (current !== generation || clock() >= deadline) { new Uint8Array(encrypted).fill(0); throw Error('Diagnostic retention cancelled'); }
      key = nextKey; iv = nextIv; ciphertext = encrypted; expiresAt = deadline;
      timer = schedule(() => erase('expired'), Math.max(0, deadline-clock()));
    },
    async read() {
      if (!available()) throw Error('Diagnostic recording is no longer retained');
      const current = generation;
      const plain = await cryptoImpl.subtle.decrypt({name:'AES-GCM',iv}, key, ciphertext);
      if (current !== generation || !available()) { new Uint8Array(plain).fill(0); throw Error('Diagnostic recording expired'); }
      return new Uint8Array(plain);
    },
    available, erase,
  };
}

export function encodeMonoWav(channels, sampleRate, start = 0, end = channels[0].length) {
  const size = Math.max(0, end-start), buffer = new ArrayBuffer(44+size*2), view = new DataView(buffer);
  const text=(offset,value)=>[...value].forEach((c,i)=>view.setUint8(offset+i,c.charCodeAt(0)));
  text(0,'RIFF'); view.setUint32(4,36+size*2,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,size*2,true);
  for(let i=0;i<size;i++){let value=0;for(const channel of channels)value+=channel[start+i]/channels.length;value=Math.max(-1,Math.min(1,value));view.setInt16(44+i*2,value<0?value*32768:value*32767,true);}
  return new Uint8Array(buffer);
}
