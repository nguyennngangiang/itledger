import type { Device, Handover, User } from '../types'

type TableListProps = {
  devices: Device[]
  handovers: Handover[]
  users: User[]
}

function TableList({ devices, handovers, users }: TableListProps) {
  return (
    <div className="main-content">
      <div className="device-table-container">
        <table className="device-table">
          <thead>
            <tr>
              <th>Serial Number</th>
              <th>Device Name</th>
              <th>Brand</th>
              <th>CPU</th>
              <th>RAM</th>
              <th>Storage</th>
              <th>OS</th>
              <th>MS Office</th>
              <th>Buy Date</th>
              <th>Employee Code</th>
              <th>Employee Name</th>
              <th>Team</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => {
              const deviceHandovers = handovers.filter(
                (handover) => handover.device_id === device.serial_number,
              )

              const latestHandover =
                deviceHandovers.length > 0
                  ? deviceHandovers[deviceHandovers.length - 1]
                  : undefined

              const owner = users.find(
                (user) => user.employee_code === latestHandover?.to_user_id,
              )

              return (
                <tr key={device.serial_number}>
                  <td>{device.serial_number}</td>
                  <td>{device.name}</td>
                  <td>{device.brand}</td>
                  <td>{device.cpu}</td>
                  <td>{device.ram}</td>
                  <td>{device.storage}</td>
                  <td>{device.os}</td>
                  <td>{device.msoffice}</td>
                  <td>{device.buy_date}</td>
                  <td>{owner?.employee_code ?? ''}</td>
                  <td>{owner?.name ?? ''}</td>
                  <td>{owner?.team ?? ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default TableList
