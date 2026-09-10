import { basename } from 'node:path';

const anchorMode = '__wtm_internal_anchor';
const adapterMode = '__wtm_internal_adapter';
const endpointProbeMode = '__wtm_internal_endpoint_probe';
const endpointBatchProbeMode = '__wtm_internal_endpoint_batch_probe';
const markerPattern = /^[a-f0-9]{64}$/;
const maxDescriptor = 0x7fff_ffff;

export async function runInternalMode(argv: readonly string[]): Promise<number | null> {
  const mode = argv[0];
  if (mode === anchorMode) {
    const marker = argv[1];
    if (argv.length !== 2 || marker === undefined || !markerPattern.test(marker)) return 2;
    try {
      const { runProcessAnchor } = await import('../../daemon/src/process-anchor');
      return await runProcessAnchor(marker);
    }
    catch { return 1; }
  }
  if (mode === adapterMode) {
    const rawDescriptor = argv[1];
    const executableBasename = argv[2];
    if (
      argv.length !== 3
      || rawDescriptor === undefined
      || !/^[0-9]+$/.test(rawDescriptor)
      || executableBasename === undefined
      || !validBasename(executableBasename)
    ) return 2;
    const descriptor = Number(rawDescriptor);
    if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > maxDescriptor) return 2;
    try {
      const { runAdapterChild } = await import('../../core/src/plan/adapter-runner');
      return await runAdapterChild(descriptor, executableBasename);
    }
    catch { return 1; }
  }
  if (mode === endpointProbeMode) {
    const candidate = argv[1];
    if (argv.length !== 2 || candidate === undefined || candidate.length > 512) return 2;
    try {
      const { runEndpointProbe } = await import('../../core/src/runtime/endpoint-probe');
      return await runEndpointProbe(candidate);
    }
    catch { return 1; }
  }
  if (mode === endpointBatchProbeMode) {
    if (argv.length !== 1) return 2;
    try {
      const { maxEndpointBatchInputBytes } = await import('../../core/src/runtime/endpoint-batch');
      const chunks: Buffer[] = [];
      let bytes = 0;
      // stdin avoids Windows command-line size limits. The parent owns the helper deadline.
      for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        bytes += buffer.length;
        if (bytes > maxEndpointBatchInputBytes) return 2;
        chunks.push(buffer);
      }
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      const { runEndpointBatchProbe } = await import('../../core/src/runtime/endpoint-probe');
      return await runEndpointBatchProbe(raw);
    }
    catch { return 2; }
  }
  return null;
}

function validBasename(value: string): boolean {
  return value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('\0')
    && Buffer.byteLength(value) <= 255
    && basename(value) === value;
}
