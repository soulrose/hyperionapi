// Mock SOAP service for tests and the demo: GET /hospital?wsdl (document/literal, SOAP 1.1 + 1.2 ports),
// GET /hospital?xsd=common (an imported schema), POST /hospital answers GetPatient and BookAppointment.
// An empty or unknown HN answers a SOAP Fault. Responses carry X-Soap-Version / X-Soap-Action so tests can check headers.
import http from 'node:http';
import { parseXml, textOf, walk } from './xml.mjs';

const TNS = 'http://example.org/hospital';
const COMMON = 'http://example.org/common';
const ENV = { '1.1': 'http://schemas.xmlsoap.org/soap/envelope/', '1.2': 'http://www.w3.org/2003/05/soap-envelope' };
const PATIENTS = {
  123456: { firstName: 'Somchai', lastName: 'Jaidee', birthDate: '1980-05-01' },
  123: { firstName: 'Suda', lastName: 'Rakdee', birthDate: '1975-11-20' },
  42: { firstName: 'Arthur', lastName: 'Dent', birthDate: '1952-03-11' },
};

const COMMON_XSD = `<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="${COMMON}" elementFormDefault="qualified">
  <xsd:simpleType name="Department">
    <xsd:restriction base="xsd:string">
      <xsd:enumeration value="OPD"/>
      <xsd:enumeration value="ER"/>
      <xsd:enumeration value="IPD"/>
    </xsd:restriction>
  </xsd:simpleType>
</xsd:schema>
`;

const wsdl = (address) => `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
    xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/" xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:tns="${TNS}" xmlns:cm="${COMMON}" targetNamespace="${TNS}" name="Hospital">
  <wsdl:types>
    <xsd:schema targetNamespace="${TNS}" elementFormDefault="qualified">
      <xsd:import namespace="${COMMON}" schemaLocation="hospital?xsd=common"/>
      <xsd:element name="GetPatient">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="hn" type="xsd:string"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
      <xsd:element name="GetPatientResponse">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="patient" type="tns:Patient"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
      <xsd:complexType name="Patient">
        <xsd:sequence>
          <xsd:element name="hn" type="xsd:string"/>
          <xsd:element name="firstName" type="xsd:string"/>
          <xsd:element name="lastName" type="xsd:string"/>
          <xsd:element name="birthDate" type="xsd:date"/>
        </xsd:sequence>
      </xsd:complexType>
      <xsd:element name="BookAppointment">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="patient">
              <xsd:complexType>
                <xsd:sequence>
                  <xsd:element name="hn" type="xsd:string"/>
                  <xsd:element name="phone" type="xsd:string" minOccurs="0"/>
                </xsd:sequence>
              </xsd:complexType>
            </xsd:element>
            <xsd:element name="slot" type="tns:Slot"/>
            <xsd:element ref="tns:note" minOccurs="0" maxOccurs="unbounded"/>
            <xsd:choice>
              <xsd:element name="walkIn" type="xsd:boolean"/>
              <xsd:element name="referralNo" type="xsd:string"/>
            </xsd:choice>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
      <xsd:element name="note" type="xsd:string"/>
      <xsd:complexType name="Slot">
        <xsd:sequence>
          <xsd:element name="date" type="xsd:date"/>
          <xsd:element name="department" type="cm:Department"/>
          <xsd:element name="durationMin" type="xsd:int"/>
        </xsd:sequence>
      </xsd:complexType>
      <xsd:element name="BookAppointmentResponse">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="appointmentId" type="xsd:string"/>
            <xsd:element name="status" type="xsd:string"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
    </xsd:schema>
  </wsdl:types>
  <wsdl:message name="GetPatientIn"><wsdl:part name="parameters" element="tns:GetPatient"/></wsdl:message>
  <wsdl:message name="GetPatientOut"><wsdl:part name="parameters" element="tns:GetPatientResponse"/></wsdl:message>
  <wsdl:message name="BookAppointmentIn"><wsdl:part name="parameters" element="tns:BookAppointment"/></wsdl:message>
  <wsdl:message name="BookAppointmentOut"><wsdl:part name="parameters" element="tns:BookAppointmentResponse"/></wsdl:message>
  <wsdl:portType name="HospitalPortType">
    <wsdl:operation name="GetPatient"><wsdl:input message="tns:GetPatientIn"/><wsdl:output message="tns:GetPatientOut"/></wsdl:operation>
    <wsdl:operation name="BookAppointment"><wsdl:input message="tns:BookAppointmentIn"/><wsdl:output message="tns:BookAppointmentOut"/></wsdl:operation>
  </wsdl:portType>
  <wsdl:binding name="HospitalSoap" type="tns:HospitalPortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="GetPatient">
      <soap:operation soapAction="${TNS}/GetPatient"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input><wsdl:output><soap:body use="literal"/></wsdl:output>
    </wsdl:operation>
    <wsdl:operation name="BookAppointment">
      <soap:operation soapAction="${TNS}/BookAppointment"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input><wsdl:output><soap:body use="literal"/></wsdl:output>
    </wsdl:operation>
  </wsdl:binding>
  <wsdl:binding name="HospitalSoap12" type="tns:HospitalPortType">
    <soap12:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="GetPatient">
      <soap12:operation soapAction="${TNS}/GetPatient"/>
      <wsdl:input><soap12:body use="literal"/></wsdl:input><wsdl:output><soap12:body use="literal"/></wsdl:output>
    </wsdl:operation>
    <wsdl:operation name="BookAppointment">
      <soap12:operation soapAction="${TNS}/BookAppointment"/>
      <wsdl:input><soap12:body use="literal"/></wsdl:input><wsdl:output><soap12:body use="literal"/></wsdl:output>
    </wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="HospitalService">
    <wsdl:port name="HospitalSoap" binding="tns:HospitalSoap"><soap:address location="${address}"/></wsdl:port>
    <wsdl:port name="HospitalSoap12" binding="tns:HospitalSoap12"><soap12:address location="${address}"/></wsdl:port>
  </wsdl:service>
</wsdl:definitions>
`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const envelope = (v, body) => `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="${ENV[v]}" xmlns:h="${TNS}">
  <soap:Body>
${body}
  </soap:Body>
</soap:Envelope>
`;
const fault = (v, client, msg) =>
  v === '1.2'
    ? `    <soap:Fault>
      <soap:Code><soap:Value>soap:${client ? 'Sender' : 'Receiver'}</soap:Value></soap:Code>
      <soap:Reason><soap:Text xml:lang="en">${esc(msg)}</soap:Text></soap:Reason>
    </soap:Fault>`
    : `    <soap:Fault>
      <faultcode>soap:${client ? 'Client' : 'Server'}</faultcode>
      <faultstring>${esc(msg)}</faultstring>
    </soap:Fault>`;

/** Starts the mock on 127.0.0.1:port (0 = any). Returns { url (service address), wsdlUrl, close }. */
export async function startSoapMock({ port = 0 } = {}) {
  let address = '';
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/hospital') return res.writeHead(404).end();
    if (req.method === 'GET') {
      if (u.searchParams.has('wsdl')) return res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' }).end(wsdl(address));
      if (u.searchParams.get('xsd') === 'common') return res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' }).end(COMMON_XSD);
      return res.writeHead(404).end();
    }
    if (req.method !== 'POST') return res.writeHead(405).end();
    let raw = '';
    for await (const c of req) raw += c;
    const type = String(req.headers['content-type'] ?? '');
    const v = /application\/soap\+xml/i.test(type) ? '1.2' : '1.1';
    const action = v === '1.2' ? type.match(/action="?([^";]*)"?/i)?.[1] ?? '' : String(req.headers.soapaction ?? '').replace(/^"|"$/g, '');
    const reply = (status, body) =>
      res
        .writeHead(status, { 'Content-Type': v === '1.2' ? 'application/soap+xml; charset=utf-8' : 'text/xml; charset=utf-8', 'X-Soap-Version': v, 'X-Soap-Action': action, 'X-SOAPAction-Header': String(req.headers.soapaction ?? '(none)') })
        .end(envelope(v, body));
    let root;
    try {
      root = parseXml(raw);
    } catch {
      root = null;
    }
    const op = root?.local === 'Envelope' ? root.children.find((c) => c.local === 'Body')?.children[0] : null;
    if (!op) return reply(v === '1.2' ? 400 : 500, fault(v, true, 'Request is not a SOAP envelope'));
    const find = (local, n = op) => [...walk(n)].find((x) => x.local === local);
    const val = (local, n) => textOf(find(local, n))?.trim() ?? '';

    if (op.local === 'GetPatient') {
      const hn = val('hn');
      if (!hn) return reply(500, fault(v, true, 'hn is required'));
      const p = PATIENTS[hn];
      if (!p) return reply(500, fault(v, true, `Patient ${hn} not found`));
      return reply(
        200,
        `    <h:GetPatientResponse>
      <h:patient><h:hn>${esc(hn)}</h:hn><h:firstName>${p.firstName}</h:firstName><h:lastName>${p.lastName}</h:lastName><h:birthDate>${p.birthDate}</h:birthDate></h:patient>
    </h:GetPatientResponse>`,
      );
    }
    if (op.local === 'BookAppointment') {
      const hn = val('hn', find('patient'));
      if (!hn || !PATIENTS[hn]) return reply(500, fault(v, true, hn ? `Patient ${hn} not found` : 'hn is required'));
      const slot = find('slot');
      const date = val('date', slot) || 'today';
      const dept = val('department', slot) || 'OPD';
      return reply(200, `    <h:BookAppointmentResponse><h:appointmentId>APT-${esc(hn)}-${esc(dept)}-${esc(date)}</h:appointmentId><h:status>BOOKED</h:status></h:BookAppointmentResponse>`);
    }
    return reply(500, fault(v, true, `Unknown operation ${op.local}`));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  address = `http://127.0.0.1:${server.address().port}/hospital`;
  return { url: address, wsdlUrl: `${address}?wsdl`, close: () => new Promise((r) => server.close(r)) };
}
