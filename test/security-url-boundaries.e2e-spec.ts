import { escapeHtml } from '../src/common/html-escape';
import { assertWebAppLink, buildWebAppUrl, webAppOrigin } from '../src/common/web-origin';
import { fetchTrustedOrigin } from '../src/common/trusted-fetch';
import { safeSqlIdentifier } from '../src/database/postgres-collection.store';

describe('[TBO-72 C1-C] 저장/메일/외부 요청 URL 경계', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousWebOrigin = process.env.WEB_ORIGIN;

  afterEach(() => {
    if (previousNodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousWebOrigin == null) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = previousWebOrigin;
    jest.restoreAllMocks();
  });

  it('메일 HTML 동적 값의 태그·따옴표·앰퍼샌드를 escape한다', () => {
    expect(escapeHtml(`<a href="x">'&</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&lt;/a&gt;');
  });

  it('운영 WEB_ORIGIN은 https origin-only이며 링크 query는 URL API로 인코딩한다', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.WEB_ORIGIN;
    expect(() => webAppOrigin()).toThrow('WEB_ORIGIN');
    process.env.WEB_ORIGIN = 'http://app.taco.test';
    expect(() => webAppOrigin()).toThrow('https');
    process.env.WEB_ORIGIN = 'https://user:pass@app.taco.test';
    expect(() => webAppOrigin()).toThrow('사용자');
    process.env.WEB_ORIGIN = 'https://app.taco.test/path';
    expect(() => webAppOrigin()).toThrow('origin');
    process.env.WEB_ORIGIN = 'https://app.taco.test';
    expect(buildWebAppUrl('/reset-password', { token: `a&b"c` }))
      .toBe('https://app.taco.test/reset-password?token=a%26b%22c');
    expect(() => assertWebAppLink('https://attacker.example/reset-password')).toThrow('다릅니다');
  });

  it('외부 fetch는 고정 https origin만 허용하고 redirect error와 timeout signal을 강제한다', async () => {
    await expect(fetchTrustedOrigin(
      'https://attacker.example/messages',
      'https://sens.apigw.ntruss.com',
      { method: 'POST' },
    )).rejects.toThrow('허용되지 않은');

    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
    await fetchTrustedOrigin(
      'https://sens.apigw.ntruss.com/sms/v2/messages',
      'https://sens.apigw.ntruss.com',
      { method: 'POST' },
      500,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('동적 SQL 식별자는 소문자 snake_case만 허용한다', () => {
    expect(safeSqlIdentifier('class_sessions')).toBe('class_sessions');
    for (const value of ['users;drop table users', 'users--', 'UserRoles', 'user roles', '"users"']) {
      expect(() => safeSqlIdentifier(value)).toThrow('Unsafe SQL identifier');
    }
  });
});
