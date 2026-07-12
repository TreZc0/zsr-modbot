const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const HASH_WIDTH = 17;
const HASH_HEIGHT = 16;
const HASH_BITS = (HASH_WIDTH - 1) * HASH_HEIGHT;
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

async function createDifferenceHash(input) {
  const pixels = await sharp(input, { animated: false })
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize(HASH_WIDTH, HASH_HEIGHT, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer();
  const hash = Buffer.alloc(HASH_BITS / 8);

  let bit = 0;
  for (let y = 0; y < HASH_HEIGHT; y++) {
    const rowOffset = y * HASH_WIDTH;
    for (let x = 0; x < HASH_WIDTH - 1; x++) {
      if (pixels[rowOffset + x] > pixels[rowOffset + x + 1]) {
        hash[bit >> 3] |= 1 << (7 - (bit & 7));
      }
      bit++;
    }
  }

  return hash;
}

function hammingDistance(left, right) {
  if (left.length !== right.length) {
    throw new Error('Cannot compare image hashes of different lengths');
  }

  let distance = 0;
  for (let i = 0; i < left.length; i++) {
    let value = left[i] ^ right[i];
    while (value !== 0) {
      value &= value - 1;
      distance++;
    }
  }
  return distance;
}

async function loadReferenceImages(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const references = [];
  for (const entry of entries) {
    if (!entry.isFile() || !SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }

    const filePath = path.join(directory, entry.name);
    try {
      references.push({ name: entry.name, hash: await createDifferenceHash(filePath) });
    } catch (error) {
      console.error(`Could not index reference image ${filePath}:`, error);
    }
  }
  return references;
}

async function findClosestReference(input, references) {
  if (references.length === 0) return null;

  const candidateHash = await createDifferenceHash(input);
  let closest = null;
  for (const reference of references) {
    const distance = hammingDistance(candidateHash, reference.hash);
    if (!closest || distance < closest.distance) {
      closest = {
        name: reference.name,
        distance,
        similarity: 1 - (distance / HASH_BITS)
      };
    }
  }
  return closest;
}

module.exports = {
  HASH_BITS,
  createDifferenceHash,
  findClosestReference,
  hammingDistance,
  loadReferenceImages
};
