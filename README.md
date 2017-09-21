# Migrations

# How to run
1. Make sure you have `npx` installed (if you have `npm` version 5.2.0 or later, it is already installed)
2. Run the migration with
```
npx -p sanity-io/migrations <migration>
```

E.g:
```
npx -p sanity-io/migrations date-to-richdate
```

## Supported migrations

- `date-to-richdate` - More info at https://sanity.io/help/migrate-to-rich-date
- `block-spans-to-children` - More info at https://sanity.io/help/migrate-to-block-children
