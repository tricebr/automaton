import {it,expect} from 'vitest';
import {assertPublicEndpoint} from '../online/sources.js';
it.each([
 'https://api.github.com/repos/Specula-Labs/specula-api/readme',
 'https://api.github.com/repos/Specula-Labs/specula-api/contents/.github/FUNDING.yml',
 'https://api.github.com/repos/Specula-Labs/.github/contents/profile/README.md',
 'https://api.github.com/repos/Specula-Labs/specula-api/issues?state=all&sort=updated&direction=desc&per_page=30',
 'https://github.com/Specula-Labs/specula-api/discussions',
])('allows a fixed anonymous research surface: %s',url=>expect(assertPublicEndpoint(url).href).toBe(url));
it.each([
 'https://api.github.com/repos/Specula-Labs/specula-api/contents/.env',
 'https://api.github.com/repos/Specula-Labs/specula-api/actions/secrets',
 'https://api.github.com/repos/Specula-Labs/specula-api/readme?ref=private',
 'https://api.github.com/repos/Specula-Labs/specula-api/issues?state=all&sort=updated&direction=desc&per_page=30&page=2',
 'https://api.github.com/repos/Specula-Labs/specula-api/issues?state=all&sort=updated&direction=desc&per_page=100',
 'https://api.github.com/repos/Specula-Labs/specula-api/contents/%2eenv',
 'https://api.github.com.evil.invalid/repos/Specula-Labs/specula-api/readme',
 'https://github.com/Specula-Labs/specula-api/discussions?query=secret',
 'https://raw.githubusercontent.com/Specula-Labs/specula-api/main/README.md',
 'https://user:secret@api.github.com/repos/Specula-Labs/specula-api/readme',
 'https://127.0.0.1/repos/Specula-Labs/specula-api/readme',
])('denies broad, credentialed or redirected research targets: %s',url=>expect(()=>assertPublicEndpoint(url)).toThrow());
