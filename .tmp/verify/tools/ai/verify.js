"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
// tools/ai/verify.ts
// Harness write test — ok
//change
var assert_1 = require("assert");
var sviNS = __importStar(require("../../apps/server/src/volModels/sviMapping"));
// Support both named exports and default-only exports (CJS interop)
var M = sviNS;
var get = function (k) { var _a, _b; return (_a = M[k]) !== null && _a !== void 0 ? _a : (_b = M.default) === null || _b === void 0 ? void 0 : _b[k]; };
var SVI = get("SVI");
var toMetrics = get("toMetrics");
var fromMetrics = get("fromMetrics");
var s0FromWings = get("s0FromWings");
var approx = function (a, b, eps) {
    if (eps === void 0) { eps = 1e-9; }
    return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
};
function randomSVI() {
    var a = Math.random() * 0.2 + 0.02;
    var b = Math.random() * 5 + 0.5;
    var rho = Math.max(-0.999, Math.min(0.999, (Math.random() * 2 - 1) * 0.9));
    var m = Math.random() * 0.6 - 0.3;
    var sigma = Math.random() * 0.6 + 0.05;
    return { a: a, b: b, rho: rho, m: m, sigma: sigma };
}
(function main() {
    return __awaiter(this, void 0, void 0, function () {
        var sviObj, m0, svi2, m1, h, Ssum0, b0, S0_new, rho_new, S_pos_new, S_neg_new, Ssum1, S0_check;
        return __generator(this, function (_a) {
            console.log("[verify] Node:", process.version);
            console.log("[verify] CWD:", process.cwd());
            (0, assert_1.strict)(typeof SVI === "object", "SVI export missing");
            (0, assert_1.strict)(typeof toMetrics === "function", "toMetrics export missing");
            (0, assert_1.strict)(typeof fromMetrics === "function", "fromMetrics export missing");
            console.log("[verify] Exports: OK");
            sviObj = randomSVI();
            m0 = toMetrics(sviObj);
            svi2 = fromMetrics(m0, {});
            m1 = toMetrics(svi2);
            (0, assert_1.strict)(approx(m0.S0, m1.S0, 1e-8));
            console.log("[verify] Round-trip metric idempotence: OK");
            h = Math.max(Math.abs(m0.S0) * 1e-3, 1e-4);
            Ssum0 = m0.S_pos + m0.S_neg;
            b0 = Ssum0 / 2;
            S0_new = m0.S0 + h;
            rho_new = S0_new / Math.max(b0, 1e-8);
            S_pos_new = b0 * (1 + rho_new);
            S_neg_new = b0 * (1 - rho_new);
            Ssum1 = S_pos_new + S_neg_new;
            (0, assert_1.strict)(approx(Ssum1, Ssum0, 1e-9));
            S0_check = s0FromWings(__assign(__assign({}, m0), { S_pos: S_pos_new, S_neg: S_neg_new, S0: 0, C0: m0.C0, L0: m0.L0 }));
            (0, assert_1.strict)(approx(S0_check, S0_new, 1e-9));
            console.log("[verify] Constrained S0 bump preserves b and updates wings: OK");
            console.log("[verify] All checks passed ✅");
            return [2 /*return*/];
        });
    });
})().catch(function (err) {
    console.error("[verify] FAILED:", err);
    process.exit(1);
});
