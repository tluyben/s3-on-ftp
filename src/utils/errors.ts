import { buildErrorXml } from './xml.js';

export interface S3ErrorDef {
  status: number;
  code: string;
}

export const S3_ERRORS = {
  NoSuchBucket:           { status: 404, code: 'NoSuchBucket' },
  NoSuchKey:              { status: 404, code: 'NoSuchKey' },
  AccessDenied:           { status: 403, code: 'AccessDenied' },
  InvalidBucketName:      { status: 400, code: 'InvalidBucketName' },
  BucketAlreadyExists:    { status: 409, code: 'BucketAlreadyExists' },
  BucketAlreadyOwnedByYou:{ status: 409, code: 'BucketAlreadyOwnedByYou' },
  InternalError:          { status: 500, code: 'InternalError' },
  NotImplemented:         { status: 501, code: 'NotImplemented' },
  InvalidClientTokenId:   { status: 403, code: 'InvalidClientTokenId' },
  MissingSecurityHeader:  { status: 400, code: 'MissingSecurityHeader' },
} as const;

export type S3ErrorCode = keyof typeof S3_ERRORS;

export function s3ErrorResponse(code: S3ErrorCode, message: string): { status: number; xml: string } {
  const def = S3_ERRORS[code];
  return {
    status: def.status,
    xml: buildErrorXml(def.code, message),
  };
}
