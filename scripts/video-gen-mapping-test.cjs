// Pins how `video_generate` maps a request onto each Atlas model's OWN schema (src/edge/video-gen.ts
// buildAtlasVideoBody). The failure it guards: a field the model doesn't read is dropped in silence —
// `image` on Wan 3.0 reference-to-video rendered an unrelated velvet chair, and LTX 400'd for want of a
// `resolution` its schema defaults. Fixtures are trimmed copies of Atlas's published Input schemas.
// Run: npm run build && node scripts/video-gen-mapping-test.cjs
const assert = require('node:assert/strict');
const { buildAtlasVideoBody } = require('../dist/edge/video-gen.js');

const S = {
  wanRef: { required: ['model', 'prompt'], properties: {
    model: { type: 'string' }, prompt: { type: 'string' },
    refers: { type: 'array', maxItems: 20, items: { type: 'object', properties: { url: {}, type: {} } } },
    resolution: { type: 'string', enum: ['1080p', '720p', '480p'], default: '1080p' },
    duration: { type: 'number', enum: [-1, 2, 3, 4, 5, 6, 10, 30], default: 5 },
    ratio: { type: 'string', enum: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'], default: 'adaptive' },
    audio: { type: 'boolean', default: true }, seed: { type: 'integer' },
  } },
  seedanceRef: { required: ['model'], properties: {
    model: { type: 'string' }, prompt: { type: 'string' },
    reference_images: { type: 'array', maxItems: 9, items: { type: 'string' } },
    reference_videos: { type: 'array', maxItems: 3, items: { type: 'string' } },
    duration: { type: 'integer', enum: [-1, 4, 5, 6, 15], default: 5 },
    ratio: { type: 'string', enum: ['16:9', '9:16', 'adaptive'], default: 'adaptive' },
  } },
  klingRef: { required: ['model'], properties: {
    model: { type: 'string', default: 'kwaivgi/kling-video-o3-std/reference-to-video-test' }, prompt: { type: 'string' },
    aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1'], default: '16:9' },
    duration: { type: 'integer', enum: [3, 4, 5, 10], default: 5 },
    images: { type: 'array', maxItems: 7, items: { type: 'string' } },
    shot_type: { type: 'string', enum: ['customize', 'intelligence'] },
  } },
  ltxQuality: { required: ['model', 'prompt', 'image_url'], properties: {
    model: { type: 'string' }, prompt: { type: 'string' }, image_url: { type: 'string' },
    num_frames: { type: 'integer', default: 121, minimum: 25, maximum: 257 },
    resolution: { type: 'string', enum: ['square_hd', 'square', 'portrait_3_4', 'portrait_9_16', 'landscape_4_3', 'landscape_16_9'], default: 'landscape_16_9' },
    generate_audio: { type: 'boolean', default: false },
  } },
  ltxFast: { required: ['model', 'image'], properties: {
    model: { type: 'string' }, image: { type: 'string' }, prompt: { type: 'string' },
    duration: { type: 'integer', enum: [6, 8, 10, 20], default: 6 },
    resolution: { type: 'string', enum: ['720p', '1080p'], default: '720p' },
    aspect_ratio: { type: 'string', enum: ['16:9', '9:16'], default: '16:9' },
    fps: { type: 'integer', enum: [24, 25, 48, 50], default: 24 },
  } },
};
const IMG = 'https://example.com/still.jpg', IMG2 = 'https://example.com/b.jpg';
const build = (req, model, schema) => buildAtlasVideoBody({ prompt: 'p', ...req }, model, schema);
const throws = (fn, re) => assert.throws(fn, (e) => re.test(e.message));

// 1. The salonking call exactly: `image` on a reference-only model becomes its first reference.
{
  const { body } = build({ imageUrl: IMG, durationSec: 5, aspectRatio: '9:16' }, 'alibaba/wan-3.0/reference-to-video', S.wanRef);
  assert.deepEqual(body.refers, [{ url: IMG, type: 'image' }]);
  assert.equal(body.image, undefined);
  assert.equal(body.ratio, '9:16');
  assert.equal(body.resolution, '1080p', 'enum default filled');
  assert.equal(body.audio, undefined, 'non-enum defaults are left to the vendor');
}
// 2. referenceImages → each model's own list field and item shape.
assert.deepEqual(build({ referenceImageUrls: [IMG, IMG2] }, 'w', S.wanRef).body.refers, [{ url: IMG, type: 'image' }, { url: IMG2, type: 'image' }]);
assert.deepEqual(build({ referenceImageUrls: [IMG] }, 's', S.seedanceRef).body.reference_images, [IMG]);
assert.deepEqual(build({ referenceImageUrls: [IMG] }, 'k', S.klingRef).body.images, [IMG]);
assert.equal(build({ referenceImageUrls: [IMG] }, 'k', S.klingRef).body.model, 'k', 'never the schema\'s model default');
throws(() => build({ referenceImageUrls: Array(8).fill(IMG) }, 'k', S.klingRef), /at most 7/);
// 3. A seed-only model: one reference becomes the seed; two is an error, not a silent drop.
assert.equal(build({ referenceImageUrls: [IMG] }, 'l', S.ltxQuality).body.image_url, IMG);
throws(() => build({ referenceImageUrls: [IMG, IMG2] }, 'l', S.ltxQuality), /takes no reference images/);
// 4. LTX quality at 9:16: seed under `image_url`, aspect via the resolution preset, duration → 8k+1 frames.
{
  const { body } = build({ imageUrl: IMG, aspectRatio: '9:16', durationSec: 5 }, 'ltx-2.3-quality/image-to-video', S.ltxQuality);
  assert.equal(body.image_url, IMG);
  assert.equal(body.image, undefined);
  assert.equal(body.resolution, 'portrait_9_16');
  assert.equal(body.num_frames, 121);
  assert.equal(body.duration, undefined);
  assert.equal(build({ imageUrl: IMG, durationSec: 60 }, 'l', S.ltxQuality).body.num_frames, 257);
  assert.equal(build({ imageUrl: IMG }, 'l', S.ltxQuality).body.resolution, 'landscape_16_9', 'default filled so pricing works');
}
// 5. LTX fast: required-but-defaulted resolution is sent; duration snaps to the enum, with a note.
{
  const { body, notes } = build({ imageUrl: IMG, durationSec: 5, aspectRatio: '9:16' }, 'ltx/ltx-2.3-fast/image-to-video', S.ltxFast);
  assert.equal(body.resolution, '720p');
  assert.equal(body.aspect_ratio, '9:16');
  assert.equal(body.duration, 6);
  assert.equal(body.fps, 24);
  assert.ok(notes.some((n) => /6s/.test(n)));
}
// 6. Aspect ratios the model can't do are refused with the allowed list.
throws(() => build({ aspectRatio: '4:3' }, 'k', S.klingRef), /allowed: 16:9, 9:16, 1:1/);
throws(() => build({ aspectRatio: '21:9' }, 'l', S.ltxQuality), /no aspect-ratio setting/);
// 7. params win, never touch `model`, and unknown keys pass through with a note.
{
  const { body, notes } = build({ imageUrl: IMG, aspectRatio: '9:16', params: { resolution: '1080p', camera_motion: 'dolly_in', model: 'x', bogus: 1 } }, 'ltx/ltx-2.3-fast/image-to-video', S.ltxFast);
  assert.equal(body.resolution, '1080p');
  assert.equal(body.model, 'ltx/ltx-2.3-fast/image-to-video');
  assert.equal(body.bogus, 1);
  assert.ok(notes.some((n) => /camera_motion, bogus|bogus/.test(n)));
}
// 8. No schema (lookup failed): the historical shape, so plain image-to-video keeps working.
{
  const { body, notes } = build({ imageUrl: IMG, durationSec: 5 }, 'bytedance/seedance-2.0/image-to-video', null);
  assert.deepEqual(body, { model: 'bytedance/seedance-2.0/image-to-video', prompt: 'p', duration: 5, image: IMG });
  assert.equal(notes.length, 0);
}
console.log('video-gen mapping: ok');
