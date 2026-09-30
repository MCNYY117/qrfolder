import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { lookupMime, fileExtension, isTextual } from '../src/serving/mime.ts';

describe('fileExtension', () => {
  test('常规扩展名', () => {
    assert.equal(fileExtension('a.pdf'), '.pdf');
    assert.equal(fileExtension('a.PDF'), '.pdf', '大小写归一');
  });

  test('取最后一段', () => {
    assert.equal(fileExtension('a.tar.gz'), '.gz');
  });

  test('无扩展名', () => {
    assert.equal(fileExtension('README'), '');
    assert.equal(fileExtension('a.'), '');
  });

  test('点开头的文件名视为无扩展名', () => {
    assert.equal(fileExtension('.env'), '');
    assert.equal(fileExtension('.gitignore'), '');
  });

  test('多点文件名', () => {
    assert.equal(fileExtension('v1.2.3-final.pdf'), '.pdf');
  });
});

describe('lookupMime', () => {
  test('文档类', () => {
    assert.equal(lookupMime('手册.pdf'), 'application/pdf');
    assert.match(lookupMime('a.docx'), /wordprocessingml/);
    assert.match(lookupMime('a.xlsx'), /spreadsheetml/);
  });

  test('文本类带 charset', () => {
    assert.equal(lookupMime('a.txt'), 'text/plain; charset=utf-8');
    assert.equal(lookupMime('a.csv'), 'text/csv; charset=utf-8');
    assert.equal(lookupMime('a.md'), 'text/markdown; charset=utf-8');
  });

  test('图片与音视频', () => {
    assert.equal(lookupMime('a.png'), 'image/png');
    assert.equal(lookupMime('a.jpg'), 'image/jpeg');
    assert.equal(lookupMime('a.mp4'), 'video/mp4');
    assert.equal(lookupMime('a.mp3'), 'audio/mpeg');
  });

  test('★ 复合后缀按最后一段判定（Content-Type 描述的是存储字节）', () => {
    // .tar.gz 的存储字节就是 gzip，报成 application/x-tar 会让
    // 信任该类型的客户端解压失败。这里刻意不做两段式特判。
    assert.equal(lookupMime('backup.tar.gz'), 'application/gzip');
    assert.equal(lookupMime('backup.tar.bz2'), 'application/x-bzip2');
    assert.equal(lookupMime('backup.tar.xz'), 'application/x-xz');
    assert.equal(lookupMime('backup.gz'), 'application/gzip');
    // 裸 .tar 仍是 tar
    assert.equal(lookupMime('backup.tar'), 'application/x-tar');
  });

  test('未知扩展名归为 octet-stream', () => {
    assert.equal(lookupMime('a.qqq'), 'application/octet-stream');
    assert.equal(lookupMime('noext'), 'application/octet-stream');
    assert.equal(lookupMime('.env'), 'application/octet-stream');
  });

  test('工程图纸格式', () => {
    assert.equal(lookupMime('a.step'), 'model/step');
    assert.equal(lookupMime('a.dwg'), 'image/vnd.dwg');
  });
});

describe('isTextual', () => {
  test('文本类型返回 true', () => {
    assert.equal(isTextual('text/plain; charset=utf-8'), true);
    assert.equal(isTextual('application/json; charset=utf-8'), true);
    assert.equal(isTextual('image/svg+xml'), true);
  });

  test('二进制类型返回 false', () => {
    assert.equal(isTextual('application/pdf'), false);
    assert.equal(isTextual('image/png'), false);
    assert.equal(isTextual('application/octet-stream'), false);
    assert.equal(isTextual('video/mp4'), false);
  });
});
