# DOMAIN-03-CUSTOMERS — Customer Management

## Overview
**Domain:** Customer CRUD & Notes
**Dependencies:** Auth
**MongoDB Collections:** `customers`
**Test File:** `tests/contracts/03-customers.test.ts` (2 tests)
**Contract Registry Sections:** SPU Customer Routes

---

## Story CUST-01: Customer CRUD & Notes

### Description
Implement customer list, detail, creation, update, notes, and activation management. Small domain — one story covers everything.

### Routes Covered
- `GET /spu/customers` — customer list with SPU counts
- `POST /spu/customers` (action: create)
- `GET /spu/customers/[id]` — customer detail with assigned SPUs and notes
- `POST /spu/customers/[id]` (actions: update, addNote, deactivate, reactivate)

### Contract References
**GET /spu/customers returns:**
```typescript
{
  customers: {
    id: string, name: string, customerType: string, status: string,
    contactEmail: string | null, contactPhone: string | null,
    createdAt: Date, spuCount: number
  }[]
}
```

**GET /spu/customers/[id] returns:**
```typescript
{
  customer: {
    id: string, name: string, customerType: string, status: string,
    contactEmail: string | null, contactPhone: string | null,
    address: string | null, notes: string | null,
    createdAt: Date, updatedAt: Date
  }
  assignedSpus: { id: string, udi: string, deviceState: string, assignmentType: string }[]
  customerNotes: {
    id: string, content: string, createdAt: Date, createdByUsername: string
  }[]
}
```

**Form Actions:**
- `create` — `{ name, customerType, contactEmail?, contactPhone?, address?, notes? }`
- `update` — `{ name, customerType, contactEmail?, contactPhone?, address?, notes? }`
- `addNote` — `{ content: string }`
- `deactivate` / `reactivate`

### MongoDB Models Used
- `Customer` — CRUD. Notes are **embedded** as `notes: [{ _id, noteText, createdBy: { _id, username }, createdAt }]`
- `Spu` — query for assigned SPUs: `Spu.find({ 'assignment.customer._id': customerId })`

### MongoDB-Specific Notes
- Old code had separate `CustomerNote` collection — now embedded in customer document
- `spuCount` on list page: use aggregation pipeline or a separate `Spu.countDocuments({ 'assignment.customer._id': id })` per customer
- Adding a note: `Customer.findByIdAndUpdate(id, { $push: { notes: { ... } } })`
- Contract expects `customerNotes[].createdByUsername` — denormalized as `createdBy.username` in embedded note

### Acceptance Criteria
- Tests 1-2 in `03-customers.test.ts` pass (customer list returns customers, customer detail loads)
- Customer CRUD operations work
- Notes can be added and displayed
- SPU count shows on list page
