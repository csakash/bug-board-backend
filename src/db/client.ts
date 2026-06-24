import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

// Serialize BigInt values (e.g. File.sizeBytes) safely in JSON responses.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};
