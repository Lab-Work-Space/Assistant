import prism from 'prism-media';
import type { AudioResource } from '@discordjs/voice';
import type { VoiceLib } from './library.js';
import { PcmMixer } from './mixer.js';
import type { AudioSource } from './session.js';

/**
 * P8: the resource is built in-repo from already-decoded PCM: s16le 48 kHz stereo → prism VolumeTransformer → PcmMixer (spoken
 * replies over the music, T37) → prism opus Encoder (opusscript). createAudioResource is never called: its stream-type graph probes and spawns ffmpeg through prism-media with the
 * parent env (FFmpeg.getInfo → spawnSync, and the ffmpeg edges). Any transcoding happens before, in our own childEnv() ffmpeg.
 */
export function buildResource(lib: Pick<VoiceLib, 'AudioResource'>, src: AudioSource, volume: number): { resource: AudioResource; volume: prism.VolumeTransformer; mixer: PcmMixer } {
  const vol = new prism.VolumeTransformer({ type: 's16le', volume });
  const mixer = new PcmMixer();
  const encoder = new prism.opus.Encoder({ rate: 48_000, channels: 2, frameSize: 960 });
  // AudioResource(edges, streams, metadata, silencePaddingFrames): pipes the streams; playStream is the encoder (opus packets).
  const resource = new lib.AudioResource([], [src.stream, vol, mixer, encoder], null, 5);
  return { resource, volume: vol, mixer };
}
