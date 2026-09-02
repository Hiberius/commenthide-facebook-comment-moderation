import { iconsScriptSource } from "./icons";
import { coreScript } from "./client-core";
import { renderScript } from "./client-render";
import { renderDetailScript } from "./client-render-detail";
import { actionsScript } from "./client-actions";
import { eventsScript } from "./client-events";

// The dashboard's behaviour, assembled from the fragments in this directory.
//
// Every fragment is a slice of the SAME function body, so they share one scope
// and publish nothing to `window`. They are concatenated rather than written as
// one file purely to respect the 400-line ceiling.
//
// Order is presentational, not functional: function declarations hoist within
// the IIFE, so the render fragments may call the action fragments and back.

export const clientScript: string = [
  "(function () {",
  '"use strict";',
  iconsScriptSource(),
  coreScript,
  renderScript,
  renderDetailScript,
  actionsScript,
  eventsScript,
  "})();",
].join("\n");
