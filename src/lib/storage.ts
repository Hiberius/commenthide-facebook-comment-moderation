// Single import path for the D1 storage layer: "../lib/storage".
//
// The implementation lives in ./storage/* so no module grows past the size
// budget. The explicit ./storage/index specifier matters — a bare "./storage"
// would resolve back to this very file.

export * from "./storage/index";
