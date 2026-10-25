export interface SIDFile {
  version: number;
  title: string;
  author: string;
  released: string;
  songs: number;
  startSong: number;
  speed: number;
  clock: number;
  video: 'PAL' | 'NTSC';
  model: string;
  loadAddress: number;
  initAddress: number;
  playAddress: number;
  data: Uint8Array;
}

/* Decode a one-file PSID into an owned payload and its execution parameters.
 * Header words are big-endian, but a zero load address delegates that field to
 * the first two payload bytes, in the 6502's little-endian order:
 *
 *   header [dataOffset, load=0] ... [load low][load high][6502 program ...]
 *                                                    ^ data
 *
 * Reject unsupported execution environments before allocating a machine. The
 * parser accepts one SID with callable init/play routines, not a C64 boot image.
 * Subsong numbers remain one-based here; the driver passes song-1 to init. */
export function parseSID(bytes: Uint8Array): SIDFile {
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic === 'RSID') throw new Error('RSID requires a full C64 environment and is not supported. Use a PSID file.');
  if (magic !== 'PSID') throw new Error('File is not a PSID.');
  if (bytes.length < 118) throw new Error('Truncated PSID header.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4);
  if (version < 1 || version > 4) throw new Error(`Unsupported PSID version ${version} (1-4).`);
  const headerSize = version === 1 ? 118 : 124;
  if (bytes.length < headerSize) throw new Error('Truncated PSID header.');
  let offset = view.getUint16(6);
  if (offset < headerSize || offset >= bytes.length) throw new Error('Invalid PSID data offset.');
  const flags = version >= 2 ? view.getUint16(118) : 0;
  if (flags & 3) throw new Error('MUS/PlaySID-specific PSID files are not supported.');
  if ((version >= 3 && bytes[122]) || (version >= 4 && bytes[123])) throw new Error('Multi-SID files are not supported.');
  const songs = view.getUint16(14);
  const startSong = view.getUint16(16);
  if (songs < 1 || songs > 256 || startSong < 1 || startSong > songs) throw new Error('Invalid PSID subsong range.');
  let loadAddress = view.getUint16(8);
  if (!loadAddress) {
    if (offset + 2 >= bytes.length) throw new Error('Missing PSID load address or payload.');
    loadAddress = view.getUint16(offset, true);
    offset += 2;
  }
  const data = bytes.slice(offset);
  if (loadAddress < 0x200 || loadAddress + data.length > 0x10000) throw new Error('PSID payload does not fit in available RAM.');
  const initAddress = view.getUint16(10) || loadAddress;
  const playAddress = view.getUint16(12);
  if (!playAddress) throw new Error('PSID with playAddress=0 (autonomous IRQ driver) is not supported.');
  const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 32)).split('\0')[0].trim();
  const ntsc = ((flags >> 2) & 3) === 2;
  return {
    version, title: text(22), author: text(54), released: text(86),
    songs, startSong, speed: view.getUint32(18),
    clock: ntsc ? 1022727 : 985248, video: ntsc ? 'NTSC' : 'PAL',
    model: ['unspecified', '6581', '8580', '6581/8580'][(flags >> 4) & 3],
    loadAddress, initAddress, playAddress, data,
  };
}
