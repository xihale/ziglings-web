const std = @import("std");

// Catalog generator: reads Ziglings' exercise array and emits catalog JSON
// to stdout. Designed to run against a *patched* copy of Ziglings' build.zig
// that lives in the same directory as this file (see scripts/sync-ziglings.mjs,
// which applies the `pub` patch and places both files together in a temp
// dir, then runs `zig run -Mroot=.../gen-catalog.zig`).
//
// Why a patched copy: build.zig keeps `exercises` and `Kind` file-private.
// We expose them via a reproducible transform on a throwaway copy; the
// committed submodule is never modified.
//
// Structure notes:
//   - v0.16.0 (this target): exercises + Kind live in build.zig, and build.zig
//     imports test/tests.zig (which @import("../build.zig") back — a benign
//     cycle Zig resolves). build.zig also has a comptime version check.
//   - Newer Ziglings moved these to rivendell/elrond.zig; if you upgrade the
//     submodule past that reorg, restore the elrond import.

const ziglings = @import("build.zig");

pub fn main(init: std.process.Init) !void {
    const io = init.io;

    var buf: [16 * 1024]u8 = undefined;
    var lw = std.Io.File.stdout().writer(io, &buf);
    const w = &lw.interface;

    try w.writeAll("{\n");
    try w.writeAll("  \"version\": \"PLACEHOLDER_COMMIT\",\n");
    try w.writeAll("  \"zigFloor\": \"0.16.0\",\n");
    try w.writeAll("  \"exercises\": [\n");

    for (ziglings.exercises, 0..) |ex, i| {
        // Derive fields from main_file like "001_hello.zig".
        const stem = stemOf(ex.main_file); // "001_hello"
        const number = numberFromStem(stem); // 1
        const name = nameFromStem(stem); // "hello"

        // file-IO heuristic is applied later in JS over the source text;
        // here we only clear runnable for the struct-level signals.
        const runnable = !ex.link_libc and !ex.skip and !ex.timestamp;
        const reason: ?[]const u8 = if (ex.link_libc) "link_libc"
            else if (ex.skip) "skipped"
            else if (ex.timestamp) "timestamp_exercise"
            else null;

        try w.writeAll("    {\n");
        try w.print("      \"number\": {d},\n", .{number});
        try w.print("      \"slug\": \"{s}\",\n", .{stem});
        try w.print("      \"name\": \"{s}\",\n", .{name});
        try w.print("      \"sourcePath\": \"exercises/{s}\",\n", .{ex.main_file});
        try w.print("      \"patchPath\": \"patches/{s}.patch\",\n", .{stem});
        try w.writeAll("      \"output\": ");
        try writeJsonString(w, ex.output);
        try w.writeAll(",\n");
        try w.print("      \"checkStdout\": {s},\n", .{if (ex.check_stdout) "true" else "false"});
        try w.print("      \"kind\": \"{s}\",\n", .{if (ex.kind == .@"test") "test" else "exe"});
        try w.print("      \"linkLibc\": {s},\n", .{if (ex.link_libc) "true" else "false"});
        try w.writeAll("      \"hint\": ");
        if (ex.hint) |h| try writeJsonString(w, h) else try w.writeAll("null");
        try w.writeAll(",\n");
        try w.print("      \"skip\": {s},\n", .{if (ex.skip) "true" else "false"});
        try w.print("      \"timestamp\": {s},\n", .{if (ex.timestamp) "true" else "false"});
        try w.print("      \"runnable\": {s},\n", .{if (runnable) "true" else "false"});
        try w.writeAll("      \"notRunnableReason\": ");
        if (reason) |r| {
            try w.writeAll("\"");
            try w.writeAll(r);
            try w.writeAll("\"");
        } else try w.writeAll("null");
        try w.writeAll("\n");
        try w.writeAll(if (i + 1 < ziglings.exercises.len) "    },\n" else "    }\n");
    }

    try w.writeAll("  ]\n}\n");
    try w.flush();
}

/// "001_hello.zig" -> "001_hello"
fn stemOf(main_file: []const u8) []const u8 {
    if (std.mem.lastIndexOfScalar(u8, main_file, '.')) |dot| {
        return main_file[0..dot];
    }
    return main_file;
}

/// "001_hello" -> 1  (parse leading digits, ignore zeros)
fn numberFromStem(stem: []const u8) usize {
    var n: usize = 0;
    for (stem) |c| {
        if (c >= '0' and c <= '9') {
            n = n * 10 + (c - '0');
        } else break;
    }
    return n;
}

/// "001_hello" -> "hello" (skip leading digits and the underscore)
fn nameFromStem(stem: []const u8) []const u8 {
    var i: usize = 0;
    while (i < stem.len and stem[i] >= '0' and stem[i] <= '9') : (i += 1) {}
    if (i < stem.len and stem[i] == '_') i += 1;
    return stem[i..];
}

/// Minimal JSON string escaping.
fn writeJsonString(w: anytype, s: []const u8) !void {
    try w.writeAll("\"");
    for (s) |c| {
        switch (c) {
            '"' => try w.writeAll("\\\""),
            '\\' => try w.writeAll("\\\\"),
            '\n' => try w.writeAll("\\n"),
            '\r' => try w.writeAll("\\r"),
            '\t' => try w.writeAll("\\t"),
            else => if (c < 0x20) {
                try w.print("\\u{x:0>4}", .{c});
            } else {
                try w.writeByte(c);
            },
        }
    }
    try w.writeAll("\"");
}
