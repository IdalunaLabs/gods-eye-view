import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadTflSourcesFromOpenData } from '../../server/providers/cctv/sources.js';
import {
  TFL_IMAGE_ORIGIN,
  TFL_JAMCAM_URL,
} from '../../server/providers/cctv/constants.js';

const place = ({
  id = 'JamCams_00001.07450',
  name = 'Piccadilly Circus',
  lat = 51.51,
  lon = -0.134,
  available = 'true',
  imageUrl = `${TFL_IMAGE_ORIGIN}00001.07450.jpg`,
  videoUrl = `${TFL_IMAGE_ORIGIN}00001.07450.mp4`,
} = {}) => ({
  id,
  commonName: name,
  lat,
  lon,
  additionalProperties: [
    { key: 'available', value: available },
    { key: 'imageUrl', value: imageUrl },
    ...(videoUrl == null ? [] : [{ key: 'videoUrl', value: videoUrl }]),
  ],
});

test('an official JamCam MP4 is the viewed clip and the JPEG stays the poster', async (t) => {
  const priorKey = process.env.TFL_APP_KEY;
  delete process.env.TFL_APP_KEY;
  t.after(() => {
    if (priorKey === undefined) delete process.env.TFL_APP_KEY;
    else process.env.TFL_APP_KEY = priorKey;
  });
  t.mock.method(console, 'log', () => {});
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return new Response(
      JSON.stringify([
        place(),
        place({
          id: 'JamCams_00002.00865',
          name: 'Still only',
          imageUrl: `${TFL_IMAGE_ORIGIN}00002.00865.jpg`,
          videoUrl: null,
        }),
        place({
          id: 'JamCams_00003.00001',
          name: 'Off-origin clip',
          imageUrl: `${TFL_IMAGE_ORIGIN}00003.00001.jpg`,
          videoUrl: 'https://evil.example/clip.mp4',
        }),
        place({
          id: 'JamCams_00004.00001',
          name: 'Query clip',
          imageUrl: `${TFL_IMAGE_ORIGIN}00004.00001.jpg`,
          videoUrl: `${TFL_IMAGE_ORIGIN}00004.00001.mp4?token=1`,
        }),
        place({
          id: 'JamCams_00005.00001',
          name: 'Off-origin still',
          imageUrl: 'https://evil.example/still.jpg',
          videoUrl: `${TFL_IMAGE_ORIGIN}00005.00001.mp4`,
        }),
        place({
          id: 'JamCams_00006.00001',
          name: 'Unavailable',
          available: 'false',
        }),
      ]),
    );
  });

  const cameras = await loadTflSourcesFromOpenData();
  assert.deepEqual(requested, [TFL_JAMCAM_URL]);
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    [
      'tfl-00001.07450',
      'tfl-00002.00865',
      'tfl-00003.00001',
      'tfl-00004.00001',
    ],
  );

  const motion = cameras[0];
  assert.equal(motion.feedType, 'mp4');
  assert.equal(motion.url, `${TFL_IMAGE_ORIGIN}00001.07450.mp4`);
  assert.equal(motion.snapshotUrl, `${TFL_IMAGE_ORIGIN}00001.07450.jpg`);
  assert.equal(motion.provider, 'Transport for London');
  assert.equal(motion.license, 'Powered by TfL Open Data');

  for (const camera of cameras.slice(1)) {
    assert.equal(camera.feedType, 'image');
    assert.equal(camera.url, camera.snapshotUrl);
    assert.ok(camera.url.startsWith(TFL_IMAGE_ORIGIN));
    assert.ok(!camera.url.endsWith('.mp4'));
  }
});
