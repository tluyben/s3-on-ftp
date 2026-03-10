import { create } from 'xmlbuilder2';
import type { FileEntry } from '../types/backend.js';

const S3_NS = 'http://s3.amazonaws.com/doc/2006-03-01/';

export function buildListBucketsXml(buckets: Array<{ name: string; creationDate: Date }>): string {
  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('ListAllMyBucketsResult', { xmlns: S3_NS })
      .ele('Owner')
        .ele('ID').txt('proxy-owner').up()
        .ele('DisplayName').txt('s3-proxy').up()
      .up()
      .ele('Buckets');

  for (const b of buckets) {
    root.ele('Bucket')
      .ele('Name').txt(b.name).up()
      .ele('CreationDate').txt(b.creationDate.toISOString()).up()
    .up();
  }

  return root.end({ prettyPrint: false });
}

export function buildListObjectsV2Xml(
  bucket: string,
  prefix: string,
  entries: FileEntry[],
): string {
  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('ListBucketResult', { xmlns: S3_NS })
      .ele('Name').txt(bucket).up()
      .ele('Prefix').txt(prefix).up()
      .ele('KeyCount').txt(String(entries.length)).up()
      .ele('MaxKeys').txt('1000').up()
      .ele('IsTruncated').txt('false').up();

  for (const e of entries) {
    root.ele('Contents')
      .ele('Key').txt(e.key).up()
      .ele('LastModified').txt(e.lastModified.toISOString()).up()
      .ele('ETag').txt(`"${e.etag}"`).up()
      .ele('Size').txt(String(e.size)).up()
      .ele('StorageClass').txt('STANDARD').up()
    .up();
  }

  return root.end({ prettyPrint: false });
}

// Also used for list-type=1 (ListObjects v1)
export function buildListObjectsXml(
  bucket: string,
  prefix: string,
  entries: FileEntry[],
): string {
  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('ListBucketResult', { xmlns: S3_NS })
      .ele('Name').txt(bucket).up()
      .ele('Prefix').txt(prefix).up()
      .ele('Marker').txt('').up()
      .ele('MaxKeys').txt('1000').up()
      .ele('IsTruncated').txt('false').up();

  for (const e of entries) {
    root.ele('Contents')
      .ele('Key').txt(e.key).up()
      .ele('LastModified').txt(e.lastModified.toISOString()).up()
      .ele('ETag').txt(`"${e.etag}"`).up()
      .ele('Size').txt(String(e.size)).up()
      .ele('StorageClass').txt('STANDARD').up()
    .up();
  }

  return root.end({ prettyPrint: false });
}

export function buildErrorXml(code: string, message: string, requestId = 'proxy-000'): string {
  return create({ version: '1.0', encoding: 'UTF-8' })
    .ele('Error')
      .ele('Code').txt(code).up()
      .ele('Message').txt(message).up()
      .ele('RequestId').txt(requestId).up()
    .up()
    .end({ prettyPrint: false });
}

export function buildDeleteResultXml(key: string): string {
  return create({ version: '1.0', encoding: 'UTF-8' })
    .ele('DeleteResult', { xmlns: S3_NS })
      .ele('Deleted')
        .ele('Key').txt(key).up()
      .up()
    .up()
    .end({ prettyPrint: false });
}
