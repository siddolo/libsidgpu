/* Small original PSID program shared by the CPU and browser tests. Init uses
 * the zero-based song number as a frequency-table index. Play increments the
 * low frequency byte in RAM, then writes it to SID; reading $d400 itself would
 * incorrectly depend on a write-only hardware register. */
export function sidFixture() {
  const bytes = new Uint8Array(124 + 0x80);
  bytes.set([80, 83, 73, 68]);
  const header = new DataView(bytes.buffer);
  for (const [offset, value] of [[4, 2], [6, 124], [8, 0x1000], [10, 0x1000], [12, 0x1040], [14, 2], [16, 1], [118, 0x24]]) header.setUint16(offset, value);
  bytes.set(new TextEncoder().encode('GPU player test'), 22);
  bytes.set([
    0xaa,                         /* TAX: song index. */
    0xbd, 0x70, 0x10,             /* LDA $1070,X */
    0x8d, 0x01, 0xd4,             /* STA $d401 */
    0xa9, 0x40, 0x85, 0x02,       /* LDA #$40 / STA $02 */
    0x8d, 0x00, 0xd4,
    0xa9, 0x00, 0x8d, 0x05, 0xd4,
    0xa9, 0xf0, 0x8d, 0x06, 0xd4,
    0xa9, 0x21, 0x8d, 0x04, 0xd4,
    0xa9, 0x0f, 0x8d, 0x18, 0xd4,
    0x60,
  ], 124);
  bytes.set([0xe6, 0x02, 0xa5, 0x02, 0x8d, 0x00, 0xd4, 0x60], 124 + 0x40);
  bytes.set([0x1d, 0x3a], 124 + 0x70);
  return bytes;
}
