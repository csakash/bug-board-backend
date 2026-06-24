import { PrismaClient } from '@prisma/client';
export const prisma = new PrismaClient();
// Serialize BigInt values (e.g. File.sizeBytes) safely in JSON responses.
BigInt.prototype.toJSON = function () {
    return this.toString();
};
//# sourceMappingURL=client.js.map