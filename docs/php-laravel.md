# PHP and Laravel Support

opencode-swarm v6.49+ ships with PHP as a first-class language (Tier 3) and Laravel baseline detection. This guide covers how the swarm handles PHP projects.

## Generic PHP (Composer) project

For any directory with `composer.json`, the swarm detects the `php-composer` build ecosystem and uses:

- **Build**: `composer install --no-interaction --prefer-dist`
- **Test**: PHPUnit (`vendor/bin/phpunit`) if `phpunit.xml` or `phpunit.xml.dist` is present
- **Lint**: PHP-CS-Fixer (`vendor/bin/php-cs-fixer fix --dry-run --diff`) if `.php-cs-fixer.php` is present
- **Audit**: `composer audit --locked --format=json`

### Composer audit exit codes

| Exit code | Meaning | Swarm interpretation |
|-----------|---------|---------------------|
| 0 | No issues | `clean: true`, no findings |
| 1 | Abandoned packages | `clean: true`, note listing abandoned packages |
| 2 | Security vulnerabilities | `clean: false`, structured findings per package |

Exit code 1 does NOT cause the audit gate to fail — abandoned packages are informational, not security findings.

## PHPUnit vs Pest detection

The swarm detects both test runners and prefers Pest over PHPUnit in mixed repos:

| Priority | Framework | Detection signal |
|----------|-----------|-----------------|
| 1 | Pest | `Pest.php` file in project root |
| 2 | (Laravel artisan — see below) | `artisan` file |
| 3 | PHPUnit | `phpunit.xml` |
| 4 | PHPUnit | `phpunit.xml.dist` |

**Mixed repos**: If both `Pest.php` and `phpunit.xml` are present, Pest is used. In Laravel projects, `php artisan test` is always used regardless (it wraps both).

## Laravel project detection and command override

Laravel is detected when **at least 2 of these 3 signals** are present:

| Signal | Description |
|--------|-------------|
| `artisan` file | PHP script in project root (only in Laravel projects) |
| `laravel/framework` in `require` | In `composer.json` runtime dependencies |
| `config/app.php` | Laravel application configuration file |

Note: The check is `require` (runtime), not `require-dev` — packages that include Laravel as a dev dependency are NOT detected as Laravel projects.

When detected, all commands are overridden:

```
Test:           php artisan test
                php artisan test --parallel  (for parallel mode)
Lint:           vendor/bin/pint --test       (if pint.json present)
                vendor/bin/php-cs-fixer fix --dry-run --diff  (fallback)
Static:         vendor/bin/phpstan analyse   (if phpstan.neon present)
Audit:          composer audit --locked --format=json
```

## Blade template files

`.blade.php` files are included in all relevant scanning pipelines:

- **Placeholder scanner** — finds stub implementations and TODO patterns in Blade templates
- **TODO extractor** — finds `{{-- TODO: ... --}}` and PHP-style comments
- **SAST scanner** — applies PHP rules to Blade content

Note: `path.extname('view.blade.php')` returns `.php`, so Blade files are scanned via the `.php` extension in all tools, with `.blade.php` also explicitly registered for direct extension lookups.

Repo-graph symbol extraction treats Blade templates as best-effort PHP syntax.
Plain PHP functions, classes, traits, namespaces, and `use` declarations are
represented when the PHP parser can recover them, but Blade directives, embedded
HTML, template inheritance, and Laravel runtime binding are not resolved. Use
`repo_map context_pack` output for Blade files as advisory context, not as proof
that a template reference is complete.

## Laravel SAST rules

Three Laravel-specific SAST rules are active (in addition to 10 generic PHP rules):

### sast/php-laravel-sql-injection (HIGH)

Detects raw SQL methods with unparameterized user input:

```php
// FLAGGED — string concatenation into whereRaw
$users = DB::table('users')->whereRaw('name = ' . $name)->get();

// SAFE — parameterized query
$users = DB::table('users')->whereRaw('name = ?', [$name])->get();
```

### sast/php-laravel-mass-assignment (MEDIUM)

Detects empty `$guarded` array disabling all mass-assignment protection:

```php
// FLAGGED — any attribute can be mass-assigned
protected $guarded = [];

// SAFE — explicit allowlist
protected $fillable = ['name', 'email'];
```

### sast/php-laravel-destructive-migration (MEDIUM)

Detects `Schema::drop` / `Schema::dropIfExists` without a `down()` method:

```php
// FLAGGED — no rollback support
public function up(): void {
    Schema::dropIfExists('legacy_users');
}
// (no down() method)

// SAFE — has rollback
public function down(): void {
    Schema::create('legacy_users', function (Blueprint $table) { ... });
}
```

## Test engineer guidance for Laravel projects

When the `test_engineer` agent works on Laravel projects, it receives these constraints automatically:

- Prefer **feature tests** for HTTP, middleware, and authentication flows (use `RefreshDatabase` or `DatabaseTransactions`)
- Use **unit tests** for isolated business logic classes that don't require the full application container
- **Pest and PHPUnit coexist** — `php artisan test` runs both; don't assume PHPUnit-only
- Use `.env.testing` for test-specific configuration; run `php artisan config:clear` when environment changes
- For database tests, prefer `RefreshDatabase` over manual setup to avoid state leakage
- For parallel testing (`php artisan test --parallel`), ensure separate databases per worker

## Issue #308

This release closes [GitHub Issue #308](https://github.com/zaxbysauce/opencode-swarm/issues/308) — PHP/Laravel Support? — with verified, CI-tested first-class PHP support and a meaningful Laravel baseline.
