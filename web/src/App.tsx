import { Link, Route, Routes } from 'react-router-dom';
import EditFueling from './routes/EditFueling';
import NewFueling from './routes/NewFueling';
import VehicleFuelings from './routes/VehicleFuelings';
import VehiclesHome from './routes/VehiclesHome';

export default function App() {
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col">
      <header className="border-b border-slate-800 px-4 py-3">
        <Link to="/" className="text-lg font-semibold text-emerald-400">
          ⛽ Tankstelle
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-4">
        <Routes>
          <Route path="/" element={<VehiclesHome />} />
          <Route path="/new" element={<NewFueling />} />
          <Route path="/vehicles/:id" element={<VehicleFuelings />} />
          <Route path="/fuelings/:id/edit" element={<EditFueling />} />
        </Routes>
      </main>
    </div>
  );
}
