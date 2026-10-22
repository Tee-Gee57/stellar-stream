import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";

const SENDER = Keypair.random().publicKey();
const VALID_RECIPIENT = Keypair.random().publicKey();
const EMPTY_VALID_RECIPIENT = Keypair.random().publicKey();
const OTHER_RECIPIENT = Keypair.random().publicKey();

function corruptStellarChecksum(validPublicKey: string): string {
  const lastChar = validPublicKey[validPublicKey.length - 1];
  const replacement = lastChar === "A" ? "B" : "A";
  return validPublicKey.slice(0, -1) + replacement;
}

const INVALID_CHECKSUM_RECIPIENT = corruptStellarChecksum(VALID_RECIPIENT);

const cacheMocks = vi.hoisted(() => ({
  getCache: vi.fn(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  })),
  initCache: vi.fn(),
}));

const streamStoreMocks = vi.hoisted(() => ({
  MIN_COMPARE_STREAMS: 2,
  MAX_COMPARE_STREAMS: 5,
  archiveOldStreams: vi.fn(),
  calculateProgress: vi.fn(),
  compareStreams: vi.fn(),
  cancelStream: vi.fn(),
  createStream: vi.fn(),
  deleteStreamById: vi.fn(),
  estimateCreateStreamFee: vi.fn(),
  getLatestLedgerTime: vi.fn(),
  getOnChainClaimableAmount: vi.fn(),
  getOnChainClaimableBatch: vi.fn(),
  getOnChainStreamCount: vi.fn(),
  getStream: vi.fn(),
  initSoroban: vi.fn(),
  listStreams: vi.fn(),
  listStreamsByRecipient: vi.fn(),
  listStreamsBySender: vi.fn(),
  markStreamComplete: vi.fn(),
  nowInSeconds: vi.fn(() => 1000),
  pauseStream: vi.fn(),
  reconcileStream: vi.fn(),
  refreshStreamStatuses: vi.fn(),
  resumeStream: vi.fn(),
  syncStreams: vi.fn(),
  updateStreamStartAt: vi.fn(),
}));

const eventHistoryMocks = vi.hoisted(() => ({
  countAllEvents: vi.fn(),
  countStreamEvents: vi.fn(),
  getAllEvents: vi.fn(),
  getGlobalEvents: vi.fn(),
  getStreamEventSummary: vi.fn(),
  getStreamHistory: vi.fn(),
  recordEvent: vi.fn(),
  recordEventWithDb: vi.fn(),
}));

vi.mock("./services/cache", () => cacheMocks);
vi.mock("./services/streamStore", () => streamStoreMocks);
vi.mock("./services/eventHistory", () => eventHistoryMocks);
vi.mock("./services/auth", () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
  adminJwtAuth: vi.fn((_req: any, _res: any, next: any) => next()),
  generateChallenge: vi.fn(),
  refreshToken: vi.fn(),
  verifyChallengeAndIssueToken: vi.fn(),
  getJwtSecret: vi.fn(() => "test-secret"),
}));

import { app } from "./index";

const sampleStream = {
  id: "1",
  sender: SENDER,
  recipient: VALID_RECIPIENT,
  assetCode: "USDC",
  totalAmount: 100,
  durationSeconds: 100,
  startAt: 900,
  createdAt: 1000,
  pausedDuration: 0,
  cliffSeconds: 0,
};

const sampleProgress = {
  status: "active" as const,
  ratePerSecond: 1,
  elapsedSeconds: 50,
  vestedAmount: 50,
  remainingAmount: 50,
  percentComplete: 50,
};

describe("Recipient streams endpoint boundary behavior (SSB-2026-111 / #1054)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamStoreMocks.calculateProgress.mockReturnValue(sampleProgress);
  });

  describe("Account ID checksum & format boundaries", () => {
    it("rejects corrupted checksum with 400 VALIDATION_ERROR on GET /api/recipients/:accountId/streams", async () => {
      const res = await request(app).get(
        `/api/recipients/${INVALID_CHECKSUM_RECIPIENT}/streams`,
      );
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.error).toContain("must be a valid Stellar account ID");
      expect(res.body.details?.[0].field).toBe("accountId");
      expect(streamStoreMocks.listStreamsByRecipient).not.toHaveBeenCalled();
    });

    it("rejects corrupted checksum with 400 VALIDATION_ERROR on GET /api/streams/recipient/:address", async () => {
      const res = await request(app).get(
        `/api/streams/recipient/${INVALID_CHECKSUM_RECIPIENT}`,
      );
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.error).toContain("must be a valid Stellar account ID");
      expect(streamStoreMocks.listStreamsByRecipient).not.toHaveBeenCalled();
    });

    it("rejects account IDs that do not start with G", async () => {
      const invalidPrefix = "S" + VALID_RECIPIENT.slice(1);
      const res = await request(app).get(
        `/api/recipients/${invalidPrefix}/streams`,
      );
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(streamStoreMocks.listStreamsByRecipient).not.toHaveBeenCalled();
    });

    it("rejects account IDs with invalid character length (55 and 57 chars)", async () => {
      const tooShort = VALID_RECIPIENT.slice(0, 55);
      const tooLong = VALID_RECIPIENT + "A";

      const resShort = await request(app).get(`/api/recipients/${tooShort}/streams`);
      expect(resShort.status).toBe(400);

      const resLong = await request(app).get(`/api/recipients/${tooLong}/streams`);
      expect(resLong.status).toBe(400);
    });
  });

  describe("Valid empty account versus populated recipient results", () => {
    it("returns 200 OK with an empty array for a valid empty account", async () => {
      streamStoreMocks.listStreamsByRecipient.mockReturnValue([]);

      const res1 = await request(app).get(
        `/api/recipients/${EMPTY_VALID_RECIPIENT}/streams`,
      );
      expect(res1.status).toBe(200);
      expect(res1.body).toEqual({
        data: [],
        total: 0,
        page: 1,
        limit: 0,
      });

      const res2 = await request(app).get(
        `/api/streams/recipient/${EMPTY_VALID_RECIPIENT}`,
      );
      expect(res2.status).toBe(200);
      expect(res2.body).toEqual({
        data: [],
        total: 0,
        page: 1,
        limit: 0,
      });
    });

    it("returns populated streams for a valid recipient and computes live progress", async () => {
      streamStoreMocks.listStreamsByRecipient.mockReturnValue([sampleStream]);

      const res = await request(app).get(
        `/api/recipients/${VALID_RECIPIENT}/streams`,
      );
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].id).toBe("1");
      expect(res.body.data[0].recipient).toBe(VALID_RECIPIENT);
      expect(res.body.data[0].progress.status).toBe("active");
    });
  });

  describe("Boundary query inputs & result isolation", () => {
    it("applies query.recipient filtering without silently leaking or altering scoped results", async () => {
      streamStoreMocks.listStreamsByRecipient.mockReturnValue([sampleStream]);

      // Querying matching recipient in query returns the stream
      const matchingRes = await request(app)
        .get(`/api/recipients/${VALID_RECIPIENT}/streams`)
        .query({ recipient: VALID_RECIPIENT });
      expect(matchingRes.status).toBe(200);
      expect(matchingRes.body.data).toHaveLength(1);

      // Querying conflicting recipient returns 0 results, preserving isolation
      const conflictingRes = await request(app)
        .get(`/api/recipients/${VALID_RECIPIENT}/streams`)
        .query({ recipient: OTHER_RECIPIENT });
      expect(conflictingRes.status).toBe(200);
      expect(conflictingRes.body.data).toHaveLength(0);
      expect(conflictingRes.body.total).toBe(0);
    });

    it("applies query.recipient on /api/streams/recipient/:address as well", async () => {
      streamStoreMocks.listStreamsByRecipient.mockReturnValue([sampleStream]);

      const conflictingRes = await request(app)
        .get(`/api/streams/recipient/${VALID_RECIPIENT}`)
        .query({ recipient: OTHER_RECIPIENT });
      expect(conflictingRes.status).toBe(200);
      expect(conflictingRes.body.data).toHaveLength(0);
      expect(conflictingRes.body.total).toBe(0);
    });
  });

  describe("Database query timeout handling & recovery", () => {
    it("recovers safely upon transient database lock/timeout retry", async () => {
      const busyErr = Object.assign(new Error("SQLITE_BUSY: database is locked"), {
        code: "SQLITE_BUSY",
      });
      streamStoreMocks.listStreamsByRecipient
        .mockImplementationOnce(() => {
          throw busyErr;
        })
        .mockReturnValueOnce([sampleStream]);

      const res = await request(app).get(
        `/api/recipients/${VALID_RECIPIENT}/streams`,
      );
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(streamStoreMocks.listStreamsByRecipient).toHaveBeenCalledTimes(2);
      expect(eventHistoryMocks.recordEvent).not.toHaveBeenCalled();
    });

    it("returns deterministic 503 DATABASE_TIMEOUT when database query timeout persists", async () => {
      const timeoutErr = Object.assign(
        new Error("Database query timed out while reading streams"),
        { code: "ETIMEDOUT" },
      );
      streamStoreMocks.listStreamsByRecipient.mockImplementation(() => {
        throw timeoutErr;
      });

      const res1 = await request(app).get(
        `/api/recipients/${VALID_RECIPIENT}/streams`,
      );
      expect(res1.status).toBe(503);
      expect(res1.body.code).toBe("DATABASE_TIMEOUT");
      expect(res1.body.error).toContain("Database query timed out");

      const res2 = await request(app).get(
        `/api/streams/recipient/${VALID_RECIPIENT}`,
      );
      expect(res2.status).toBe(503);
      expect(res2.body.code).toBe("DATABASE_TIMEOUT");
      expect(res2.body.error).toContain("Database query timed out");
    });
  });
});
