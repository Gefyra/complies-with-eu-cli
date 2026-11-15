# Compliance Report: My|Patient&lt;b&gt;

**Profile:** `http://example.org/fhir/StructureDefinition/My|Patient<b>`
**Package:** `example.pkg@1.0.0` | **Date:** 2026-01-01

## ❌ compliesWithProfile — Overview

**1 of 3** checked EU profiles are fulfilled.

| Status | EU Profile |
|:------:|------------|
| ❌ | `http://hl7.eu/fhir/base/StructureDefinition/patient-eu-core\|2.0.1` |
| ✅ | `http://hl7.eu/fhir/base/StructureDefinition/patient-eu-ips` |
| ❌ | `http://hl7.eu/fhir/laboratory/StructureDefinition/Patient-eu-lab\|0.1.0` |

## Non-Compliant Profiles — Details

### ❌ patient-eu-core

`http://hl7.eu/fhir/base/StructureDefinition/patient-eu-core|2.0.1`

| Path | Issue |
|------|-------|
| — | Constraint missing: `hasValue() or (children().count() > id.count())` (reported 2×) |
| `Patient.name` | min: is `0`, expected `1` |
| `Patient.name` | Constraint missing: `family.exists() or given.exists()` |
| `Patient.identifier` | No slicing found, target profile expects slicing |
| — | weird \| detail &lt;img src=x onerror=alert(1)&gt; |

## ⚠️ Obligation Check (SHALL:able-to-populate)

The FHIR Java Validator does **not** check obligations or MustSupport. The following evaluation therefore manually checks whether elements with `SHALL:able-to-populate` in the EU profile are at least marked as **MustSupport** in the validated profile and have a max cardinality > 0.

**3 violation(s)** found across 1 EU profile(s).

### 📋 Patient-eu-lab

`http://hl7.eu/fhir/laboratory/StructureDefinition/Patient-eu-lab`

| EU Element | Obligation | Issue | Cardinality (My\|Patient&lt;b&gt;) | MustSupport (My\|Patient&lt;b&gt;) |
|------------|-----------|-------|:-----------:|:-------------------:|
| `Patient.birthDate` | `SHALL:able-to-populate` | MustSupport missing | 0..1 | ❌ |
| `Patient.contact:emergency` | `SHALL:able-to-populate` | Element not found in profile | — | — |
| `Patient.photo` | `SHALL:able-to-populate` | `max: 0` — element prohibited, MustSupport missing | 0..0 | ❌ |

## ℹ️ Optional EU type slices not allowed in this profile

The validator reported these optional type slices of the EU profile as missing. This profile does not allow the type at all, which is a permitted restriction, so they were excluded from the compliance result.

| EU Profile | EU slice | Type | Details |
|-----------|----------|------|---------|
| patient-eu-core | `Patient.deceased[x]:deceasedBoolean` | `boolean` | type boolean is not allowed here (allowed: dateTime \| &lt;x&gt;); the EU slice is optional (0..1) |

## ℹ️ Automatically resolved constraints

The following `.exists() or …` constraints were not declared by the input profile, but are structurally guaranteed by the profile's min cardinalities. They were excluded from the compliance result.

| EU Profile | Element | Constraint | Fulfilled by |
|-----------|---------|------------|--------------|
| patient-eu-ips | `Patient` | `telecom.exists() or address.exists()` | Patient.address (min 1) |

## Other Validation Results

<details>
<summary>Not compliesWithProfile-specific: 1 Fatal, 1 Errors, 1 Warnings, 1 Information — expand</summary>

### Fatal

**no location**

> Fatal &amp; bad

### Errors

**StructureDefinition.snapshot.element[3] (line 12, col 7)** `Terminology_TX_NoValid_1`

> Unable to resolve ValueSet "http://x/vs|1" &lt;script&gt;alert(1)&lt;/script&gt;
> second line

### Warnings

**StructureDefinition.url** `X_W`

> Use `https`

### Information

**StructureDefinition**

> Just info

</details>
