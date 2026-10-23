// jarvis-input: the hands and the accessibility reader for bridge/screen.mjs.
//
// Built once by screen.mjs (swiftc, ships with Xcode's command line tools) into
// ~/.jarvis/bin/jarvis-input. Every command prints one JSON object.
//
//   trusted [prompt]           is Accessibility granted (and ask macOS if not)
//   front                      frontmost app, and the focused element's role
//   elements [max]             the frontmost window's controls, with centres
//   move x y
//   click x y [left|right] [count]
//   drag x1 y1 x2 y2
//   scroll dx dy               in lines; positive dy scrolls down
//   type <text>
//   key <combo>                e.g. return, cmd+t, cmd+shift+4, down, escape
//
// Coordinates are screen points, top-left origin, main display.

import AppKit
import ApplicationServices
import Foundation

func out(_ obj: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: obj, options: [])
  print(String(data: data, encoding: .utf8)!)
}

func fail(_ msg: String) -> Never {
  out(["ok": false, "error": msg])
  exit(1)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { fail("no command") }
let src = CGEventSource(stateID: .hidSystemState)

func num(_ i: Int) -> Double {
  guard i < args.count, let v = Double(args[i]) else { fail("missing number at \(i)") }
  return v
}

func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }

func mouse(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton = .left, clicks: Int64 = 1) {
  let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: button)
  e?.setIntegerValueField(.mouseEventClickState, value: clicks)
  post(e)
}

// Virtual key codes for the named keys; letters and digits by US layout.
let KEYS: [String: CGKeyCode] = [
  "return": 36, "enter": 76, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
  "forwarddelete": 117, "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
  "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
  "f9": 101, "f10": 109, "f11": 103, "f12": 111,
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
  "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
  "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31,
  "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
  ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
]

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func str(_ el: AXUIElement, _ name: String) -> String? {
  guard let v = attr(el, name) else { return nil }
  if let s = v as? String { return s.isEmpty ? nil : String(s.prefix(120)) }
  if let n = v as? NSNumber { return n.stringValue }
  return nil
}

func frame(_ el: AXUIElement) -> CGRect? {
  guard let pv = attr(el, kAXPositionAttribute), let sv = attr(el, kAXSizeAttribute) else { return nil }
  var p = CGPoint.zero, s = CGSize.zero
  AXValueGetValue(pv as! AXValue, .cgPoint, &p)
  AXValueGetValue(sv as! AXValue, .cgSize, &s)
  return CGRect(origin: p, size: s)
}

func frontApp() -> NSRunningApplication? { NSWorkspace.shared.frontmostApplication }

switch cmd {
case "trusted":
  let prompt = args.count > 1 && args[1] == "prompt"
  let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
  out(["ok": true, "trusted": AXIsProcessTrustedWithOptions(opts)])

case "front":
  let app = frontApp()
  var info: [String: Any] = ["ok": true, "app": app?.localizedName ?? "", "bundle": app?.bundleIdentifier ?? ""]
  let sys = AXUIElementCreateSystemWide()
  if let f = attr(sys, kAXFocusedUIElementAttribute) {
    let el = f as! AXUIElement
    info["role"] = str(el, kAXRoleAttribute) ?? ""
    info["subrole"] = str(el, kAXSubroleAttribute) ?? ""
  }
  out(info)

case "elements":
  let max = args.count > 1 ? Int(args[1]) ?? 250 : 250
  guard let app = frontApp() else { fail("no frontmost app") }
  let root = AXUIElementCreateApplication(app.processIdentifier)
  let window = attr(root, kAXFocusedWindowAttribute).map { $0 as! AXUIElement } ?? root
  let useful: Set<String> = [
    "AXButton", "AXTextField", "AXTextArea", "AXSearchField", "AXLink", "AXCheckBox", "AXRadioButton",
    "AXPopUpButton", "AXMenuButton", "AXMenuItem", "AXTab", "AXCell", "AXRow", "AXStaticText",
    "AXComboBox", "AXSlider", "AXImage", "AXHeading",
  ]
  var items: [[String: Any]] = []
  var queue: [(AXUIElement, Int)] = [(window, 0)]
  while !queue.isEmpty && items.count < max {
    let (el, depth) = queue.removeFirst()
    let role = str(el, kAXRoleAttribute) ?? ""
    if useful.contains(role), let r = frame(el), r.width > 1, r.height > 1 {
      let label = str(el, kAXTitleAttribute) ?? str(el, kAXDescriptionAttribute)
        ?? str(el, kAXValueAttribute) ?? str(el, kAXHelpAttribute) ?? ""
      if !(role == "AXStaticText" && label.isEmpty) {
        var item: [String: Any] = ["role": String(role.dropFirst(2)), "label": label,
                                   "x": Int(r.midX), "y": Int(r.midY)]
        if str(el, kAXSubroleAttribute) == "AXSecureTextField" { item["secure"] = true }
        items.append(item)
      }
    }
    if depth < 30, let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] {
      queue.append(contentsOf: kids.map { ($0, depth + 1) })
    }
  }
  out(["ok": true, "app": app.localizedName ?? "", "elements": items])

case "move":
  mouse(.mouseMoved, CGPoint(x: num(1), y: num(2)))
  out(["ok": true])

case "click":
  let p = CGPoint(x: num(1), y: num(2))
  let right = args.count > 3 && args[3] == "right"
  let count = args.count > 4 ? Int64(args[4]) ?? 1 : 1
  mouse(.mouseMoved, p)
  usleep(40_000)
  for i in 1...max(1, count) {
    mouse(right ? .rightMouseDown : .leftMouseDown, p, right ? .right : .left, clicks: i)
    mouse(right ? .rightMouseUp : .leftMouseUp, p, right ? .right : .left, clicks: i)
  }
  out(["ok": true])

case "drag":
  let a = CGPoint(x: num(1), y: num(2)), b = CGPoint(x: num(3), y: num(4))
  mouse(.mouseMoved, a)
  mouse(.leftMouseDown, a)
  for i in 1...20 {
    let t = Double(i) / 20
    mouse(.leftMouseDragged, CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t))
    usleep(12_000)
  }
  mouse(.leftMouseUp, b)
  out(["ok": true])

case "scroll":
  let e = CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 2,
                  wheel1: Int32(-num(2)), wheel2: Int32(-num(1)), wheel3: 0)
  post(e)
  out(["ok": true])

case "type":
  let text = args.dropFirst().joined(separator: " ")
  for chunk in stride(from: 0, to: text.utf16.count, by: 16) {
    let units = Array(text.utf16)[chunk..<min(chunk + 16, text.utf16.count)]
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
      e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: Array(units))
      post(e)
    }
    usleep(8_000)
  }
  out(["ok": true])

case "key":
  guard args.count > 1 else { fail("no key") }
  let parts = args[1].lowercased().split(separator: "+").map(String.init)
  var flags: CGEventFlags = []
  var code: CGKeyCode?
  for p in parts {
    switch p {
    case "cmd", "command": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt", "option", "opt": flags.insert(.maskAlternate)
    case "ctrl", "control": flags.insert(.maskControl)
    case "fn": flags.insert(.maskSecondaryFn)
    default:
      guard let c = KEYS[p] else { fail("unknown key \(p)") }
      code = c
    }
  }
  guard let k = code else { fail("no main key in \(args[1])") }
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: down)
    e?.flags = flags
    post(e)
  }
  out(["ok": true])

default:
  fail("unknown command \(cmd)")
}
