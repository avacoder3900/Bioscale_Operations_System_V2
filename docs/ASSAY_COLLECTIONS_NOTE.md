# Assay Collections — Which is Correct

## Findings

The `AssayDefinition` Mongoose model explicitly uses the collection name `'assay_definitions'`:

```ts
// src/lib/server/db/models/assay-definition.ts
mongoose.model('AssayDefinition', assayDefinitionSchema, 'assay_definitions')
```

All application code references `assay_definitions`:
- Sacred middleware documentation: `assay_definitions`
- All AuditLog entries use `tableName: 'assay_definitions'`
- Agent seed data references `'assay_definitions'`

## Conclusion

**`assay_definitions` is the authoritative collection.**

The `assaydefinitions` collection (if present in MongoDB) is likely an orphaned artifact — possibly created by an old version of Mongoose before the explicit collection name was added, or by a migration script. 

**Do NOT delete `assaydefinitions` from MongoDB** until the data has been inspected and confirmed to be empty or duplicated. Any real data should already be in `assay_definitions`.

## Action Required

A DBA should verify `assaydefinitions` in MongoDB Atlas is empty or contains only obsolete test data before dropping it.
