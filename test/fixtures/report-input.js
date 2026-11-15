// Shared input for the report tests: one profile checked against three EU
// profiles (one compliesWithProfile failure, one obligation failure, one pass),
// with auto-resolved constraints, an optional EU type slice that is not allowed,
// and other validator messages of every severity.
// Several values contain Markdown/HTML-significant characters on purpose.

export const EU_CORE = 'http://hl7.eu/fhir/base/StructureDefinition/patient-eu-core';
export const EU_IPS = 'http://hl7.eu/fhir/base/StructureDefinition/patient-eu-ips';
export const EU_LAB = 'http://hl7.eu/fhir/laboratory/StructureDefinition/Patient-eu-lab';

const ELE1 = 'hasValue() or (children().count() > id.count())';
const NAME_EXPR = 'family.exists() or given.exists()';

export const euSdCore = {
  snapshot: {
    element: [
      { path: 'Patient', constraint: [{ expression: ELE1 }] },
      { path: 'Patient.name', constraint: [{ expression: ELE1 }, { expression: NAME_EXPR }] },
      { path: 'Patient.gender', constraint: [{ expression: ELE1 }] },
    ],
  },
};

export function reportInput(reportPath) {
  return {
    canonical: 'http://example.org/fhir/StructureDefinition/My|Patient<b>',
    packageSpec: 'example.pkg@1.0.0',
    euCanonicals: [EU_CORE, EU_IPS, EU_LAB],
    euProfiles: [
      { url: EU_CORE, version: '2.0.1' },
      { url: EU_IPS, version: null },
      { url: EU_LAB, version: '0.1.0' },
    ],
    parsed: {
      summary: { result: 'FAILURE', text: '2 errors, 1 warnings, 1 notes' },
      issues: [
        {
          severity: 'error',
          location: 'StructureDefinition',
          message: `The profile does not comply with claimed profile '${EU_CORE}'`,
          msgId: 'SD_EXTENSION_COMPLIES_WITH_ERROR',
          details: [
            `slice error: The constraint '${ELE1}' is defined in the claimed profile, but missing`,
            "slice error: The min value of '0' on the path Patient.name does not comply with the value '1' from the claimed profile",
            `slice error: The constraint '${ELE1}' is defined in the claimed profile, but missing`,
            `slice error: The constraint '${NAME_EXPR}' is defined in the claimed profile, but missing`,
            'Mismatch in slicing at Patient.identifier: none',
            'slice error: weird | detail <img src=x onerror=alert(1)>',
          ],
        },
        {
          severity: 'error',
          location: 'StructureDefinition.snapshot.element[3]',
          line: 12,
          col: 7,
          message: 'Unable to resolve ValueSet "http://x/vs|1" <script>alert(1)</script>\nsecond line',
          msgId: 'Terminology_TX_NoValid_1',
        },
        { severity: 'fatal', location: '', message: 'Fatal & bad', msgId: null },
        { severity: 'warning', location: 'StructureDefinition.url', message: 'Use `https`', msgId: 'X_W' },
        { severity: 'information', location: 'StructureDefinition', message: 'Just info' },
      ],
    },
    reportPath,
    obligationViolationsByEuCanonical: new Map([
      [EU_LAB, [
        { euElementId: 'Patient.birthDate', obligationCode: 'SHALL:able-to-populate', matchType: 'exact', maxIsZero: false, missingMustSupport: true, inputCardinality: '0..1', inputMustSupport: false },
        { euElementId: 'Patient.contact:emergency', obligationCode: 'SHALL:able-to-populate', matchType: 'notFound' },
        { euElementId: 'Patient.photo', obligationCode: 'SHALL:able-to-populate', matchType: 'exact', maxIsZero: true, missingMustSupport: true, inputCardinality: '0..0', inputMustSupport: false },
      ]],
    ]),
    autoSatisfiedConstraints: [
      { euCanonical: EU_IPS, expression: 'telecom.exists() or address.exists()', basePath: 'Patient', matchedChild: 'Patient.address (min 1)' },
      {
        kind: 'type-slice', euCanonical: EU_CORE, basePath: 'Patient.deceased[x]:deceasedBoolean', sliceName: 'deceasedBoolean', type: 'boolean',
        expression: 'Mismatch in slicing at Patient.deceased[x]:deceasedBoolean: no slice found for the discriminator type:$this with the values boolean',
        matchedChild: 'type boolean is not allowed here (allowed: dateTime | <x>); the EU slice is optional (0..1)',
      },
    ],
    euSdByCanonical: new Map([[EU_CORE, euSdCore]]),
  };
}
